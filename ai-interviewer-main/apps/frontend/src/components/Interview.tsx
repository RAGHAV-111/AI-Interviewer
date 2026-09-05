import { BACKEND_URL } from "@/lib/config";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertTriangle, Bot, Loader2, PhoneOff, User } from "lucide-react";
import { Button } from "./ui/button";
import { VoiceOrb } from "./VoiceOrb";
import { downsampleTo16kPCM, int16ToBase64 } from "@/lib/audio";
import { PcmPlayer } from "@/lib/pcmPlayer";

type Status = "connecting" | "live" | "ending" | "error";

/** Attaches an analyser to a mic stream or a synthesized audio node and returns a getter for its current 0..1 volume level. */
function createLevelMeter(ctx: AudioContext, source: MediaStream | AudioNode) {
    const node = source instanceof MediaStream ? ctx.createMediaStreamSource(source) : source;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    node.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    return () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Boost and clamp so normal speech fills most of the range.
        return Math.min(1, rms * 3.2);
    };
}

export function Interview() {
    const { interviewId } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<Status>("connecting");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [aiLevel, setAiLevel] = useState(0);
    const [userLevel, setUserLevel] = useState(0);

    // Resources we need to tear down on exit.
    const liveWsRef = useRef<WebSocket | null>(null);
    const userStreamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const playbackCtxRef = useRef<AudioContext | null>(null);
    const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const captureProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const playerRef = useRef<PcmPlayer | null>(null);
    const micReadyRef = useRef(false);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const audioCtx = new AudioContext();
                audioCtxRef.current = audioCtx;

                // Capture the user's microphone.
                const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (cancelled) {
                    ms.getTracks().forEach((t) => t.stop());
                    return;
                }
                userStreamRef.current = ms;
                const userMeter = createLevelMeter(audioCtx, ms);

                // Playback graph for the AI's synthesized voice.
                const playbackCtx = new AudioContext();
                playbackCtxRef.current = playbackCtx;
                const playbackGain = playbackCtx.createGain();
                playbackGain.connect(playbackCtx.destination);
                const player = new PcmPlayer(playbackCtx, playbackGain);
                playerRef.current = player;
                const aiMeter = createLevelMeter(playbackCtx, playbackGain);

                // Mic capture graph: downsample to 16kHz PCM16 and stream to the backend.
                // Wired immediately but gated by micReadyRef until the backend says "ready".
                const source = audioCtx.createMediaStreamSource(ms);
                const processor = audioCtx.createScriptProcessor(4096, 1, 1);
                captureSourceRef.current = source;
                captureProcessorRef.current = processor;
                source.connect(processor);
                // Required in most engines to pull data; output buffer is left untouched
                // (all-zero/silent) so there's no audible echo.
                processor.connect(audioCtx.destination);
                processor.onaudioprocess = (e) => {
                    if (!micReadyRef.current) return;
                    const ws = liveWsRef.current;
                    if (!ws || ws.readyState !== WebSocket.OPEN) return;
                    const pcm16 = downsampleTo16kPCM(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
                    ws.send(JSON.stringify({ type: "audio", data: int16ToBase64(pcm16) }));
                };

                // Connect to the backend's Gemini Live bridge.
                const wsUrl = `${BACKEND_URL.replace(/^http/, "ws")}/api/v1/interview/${interviewId}/live`;
                const liveWs = new WebSocket(wsUrl);
                liveWsRef.current = liveWs;

                await new Promise<void>((resolve, reject) => {
                    let settled = false;
                    liveWs.onerror = () => {
                        if (!settled) {
                            settled = true;
                            reject(new Error("Failed to connect to interview session"));
                        }
                    };
                    liveWs.onclose = (ev) => {
                        if (!settled) {
                            settled = true;
                            reject(new Error(`Session closed before starting (code ${ev.code})`));
                        }
                    };
                    liveWs.onmessage = (event) => {
                        const msg = JSON.parse(event.data as string);
                        if (msg.type === "ready") {
                            micReadyRef.current = true;
                            if (!settled) {
                                settled = true;
                                resolve();
                            }
                            return;
                        }
                        if (msg.type === "error" && !settled) {
                            settled = true;
                            reject(new Error(msg.message ?? "Interview session error"));
                        }
                    };
                });

                if (cancelled) return;

                // Steady-state message handling (post-ready): audio playback + late errors/close.
                liveWs.onmessage = (event) => {
                    const msg = JSON.parse(event.data as string);
                    if (msg.type === "audio") player.playChunk(msg.data);
                    else if (msg.type === "interrupted") player.interrupt();
                    else if (msg.type === "error") enterErrorState(msg.message ?? "Interview session error");
                };
                liveWs.onclose = () => {
                    if (status !== "ending") enterErrorState("Interview session closed unexpectedly");
                };
                liveWs.onerror = () => {
                    if (status !== "ending") enterErrorState("Interview session error");
                };

                setStatus("live");

                // Single animation loop drives both volume meters.
                const tick = () => {
                    setAiLevel(aiMeter());
                    setUserLevel(userMeter());
                    rafRef.current = requestAnimationFrame(tick);
                };
                rafRef.current = requestAnimationFrame(tick);
            } catch (error) {
                if (cancelled) return;
                cleanup();
                setErrorMessage(error instanceof Error ? error.message : String(error));
                setStatus("error");
            }
        })();

        return () => {
            cancelled = true;
            cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interviewId]);

    function enterErrorState(message: string) {
        cleanup();
        setErrorMessage(message);
        setStatus("error");
    }

    function cleanup() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        micReadyRef.current = false;
        captureProcessorRef.current?.disconnect();
        captureSourceRef.current?.disconnect();
        userStreamRef.current?.getTracks().forEach((t) => t.stop());
        liveWsRef.current?.close();
        audioCtxRef.current?.close().catch(() => {});
        playbackCtxRef.current?.close().catch(() => {});
    }

    function endInterview() {
        setStatus("ending");
        cleanup();
        navigate(`/result/${interviewId}`);
    }

    const aiSpeaking = aiLevel > 0.06 && aiLevel >= userLevel;
    const userSpeaking = userLevel > 0.06 && userLevel > aiLevel;

    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="relative flex size-2.5">
                        <span
                            className={
                                status === "live"
                                    ? "absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
                                    : "hidden"
                            }
                        />
                        <span
                            className={
                                "relative inline-flex size-2.5 rounded-full " +
                                (status === "live" ? "bg-emerald-400" : status === "error" ? "bg-destructive" : "bg-amber-400")
                            }
                        />
                    </span>
                    {status === "connecting"
                        ? "Connecting…"
                        : status === "ending"
                          ? "Wrapping up…"
                          : status === "error"
                            ? "Connection failed"
                            : "Interview live"}
                </div>
                <span className="text-sm text-muted-foreground">AI Interview</span>
            </header>

            {/* Stage */}
            <div className="flex flex-1 items-center justify-center px-6">
                {status === "connecting" ? (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Loader2 className="size-7 animate-spin" />
                        <p className="text-sm">Setting up your interview & microphone…</p>
                    </div>
                ) : status === "error" ? (
                    <div className="flex max-w-md flex-col items-center gap-3 text-center">
                        <AlertTriangle className="size-7 text-destructive" />
                        <p className="text-sm font-medium">Couldn't start the interview</p>
                        <p className="text-sm text-muted-foreground">{errorMessage}</p>
                    </div>
                ) : (
                    <div className="flex w-full max-w-3xl items-center justify-center gap-12 sm:gap-24">
                        <VoiceOrb
                            level={aiLevel}
                            speaking={aiSpeaking}
                            label="Interviewer"
                            sublabel="Listening"
                            icon={Bot}
                            accent="violet"
                        />
                        <VoiceOrb
                            level={userLevel}
                            speaking={userSpeaking}
                            label="You"
                            sublabel="Mic on"
                            icon={User}
                            accent="emerald"
                        />
                    </div>
                )}
            </div>

            {/* Controls */}
            <footer className="flex justify-center px-6 py-8">
                {status === "error" ? (
                    <Button variant="secondary" size="lg" onClick={() => navigate("/")} className="rounded-full px-6">
                        Back to start
                    </Button>
                ) : (
                    <Button
                        variant="destructive"
                        size="lg"
                        onClick={endInterview}
                        disabled={status === "ending"}
                        className="gap-2 rounded-full px-6"
                    >
                        {status === "ending" ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <PhoneOff className="size-4" />
                        )}
                        End interview
                    </Button>
                )}
            </footer>
        </main>
    );
}
