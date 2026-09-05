import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { prisma } from "./db";

const LIVE_PATH_RE = /^\/api\/v1\/interview\/([^/]+)\/live$/;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export function registerLiveBridge(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? LIVE_PATH_RE.exec(req.url) : null;
    if (!match) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const interviewId = match[1]!;
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      handleClientConnection(clientWs, interviewId).catch((err) => {
        console.error("live bridge fatal error:", err);
        try {
          clientWs.close(1011, "internal error");
        } catch {}
      });
    });
  });
}

async function handleClientConnection(clientWs: WebSocket, interviewId: string) {
  const interview = await prisma.interview.findFirst({ where: { id: interviewId } });
  if (!interview) {
    clientWs.send(JSON.stringify({ type: "error", message: "Interview not found" }));
    clientWs.close(4004, "interview not found");
    return;
  }

  const systemInstruction = `You are supposed to interview this user on their computer science intellect. Ask around 2-3 questions based
    on their experience. Please use english only during the interview.
    Here is the candidate's resume, will give you a rough idea about what the user does -
    ## Resume
    ${interview.resumeText}
  `;

  let userBuffer = "";
  let assistantBuffer = "";

  async function flush(type: "User" | "Assistant", text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    await prisma.message.create({ data: { interviewId, type, message: trimmed } });
  }

  const session = await ai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction,
    },
    callbacks: {
      onopen: () => {
        console.log(`[live ${interviewId}] gemini session open`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "ready" }));
        }
      },
      onmessage: (message: LiveServerMessage) => {
        if (message.data) {
          clientWs.send(JSON.stringify({ type: "audio", data: message.data }));
        }
        const sc = message.serverContent;
        if (sc?.inputTranscription?.text) userBuffer += sc.inputTranscription.text;
        if (sc?.outputTranscription?.text) assistantBuffer += sc.outputTranscription.text;

        // Flush per-speaker as soon as that speaker's transcript is marked finished,
        // and as a safety net always flush both on turnComplete in case a `finished`
        // flag never arrives for one side (avoids losing or fragmenting a turn).
        if (sc?.inputTranscription?.finished) {
          void flush("User", userBuffer);
          userBuffer = "";
        }
        if (sc?.outputTranscription?.finished) {
          void flush("Assistant", assistantBuffer);
          assistantBuffer = "";
        }
        if (sc?.turnComplete) {
          void flush("User", userBuffer);
          void flush("Assistant", assistantBuffer);
          userBuffer = "";
          assistantBuffer = "";
          clientWs.send(JSON.stringify({ type: "turnComplete" }));
        }
        if (sc?.interrupted) {
          clientWs.send(JSON.stringify({ type: "interrupted" }));
        }
      },
      onerror: (e: ErrorEvent) => {
        console.error(`[live ${interviewId}] gemini error:`, e.message, e);
        clientWs.send(JSON.stringify({ type: "error", message: "Upstream voice session error" }));
        clientWs.close(1011, "gemini error");
      },
      onclose: (e: CloseEvent) => {
        console.log(`[live ${interviewId}] gemini session closed: code=${e.code} reason=${e.reason}`);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
      },
    },
  });

  clientWs.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: { type?: string; data?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "audio" && msg.data) {
      session.sendRealtimeInput({ audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } });
    } else if (msg.type === "end") {
      session.sendRealtimeInput({ audioStreamEnd: true });
    }
  });

  clientWs.on("close", () => {
    void flush("User", userBuffer);
    void flush("Assistant", assistantBuffer);
    session.close();
  });
  clientWs.on("error", (err) => {
    console.error("client ws error:", err);
  });
}
