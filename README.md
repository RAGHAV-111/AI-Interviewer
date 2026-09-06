
<img width="1850" height="528" alt="image" src="https://github.com/user-attachments/assets/8b75e527-6c3f-48c2-9be8-eb84fff4942d" />

<img width="2704" height="1756" alt="image" src="https://github.com/user-attachments/assets/ced742ee-d8ec-4939-95cc-d37177b1f9d7" />

<img width="2704" height="1756" alt="image" src="https://github.com/user-attachments/assets/bbe2976e-2072-4a72-97ea-0ad01b648fb3" />


<img width="2704" height="1756" alt="image" src="https://github.com/user-attachments/assets/dfefcefa-3a8e-4bdd-89f8-e1405d6b8870" />

<img width="2614" height="1520" alt="image" src="https://github.com/user-attachments/assets/212050ac-3e29-421d-a997-e7a112035692" />


1. Resume upload → interview created
Candidate opens / (Form.tsx), picks a PDF resume, hits "Start interview."
Frontend POSTs it as multipart/form-data to POST /api/v1/pre-interview.
Backend (index.ts) validates it's actually a PDF, runs it through pdf-parse (resume.ts) to extract plain text, and creates an Interview row (resumeText, status: "Pre") in Postgres via Prisma.
Returns the new interview id; frontend navigates to /interview/:id.
2. Live voice session starts
Interview.tsx mounts, grabs the mic (getUserMedia), and opens a plain WebSocket to the backend: ws://.../api/v1/interview/:id/live.
Backend (live.ts) looks up that interview's resumeText, builds a system prompt ("interview this candidate on their CS background, here's their resume: ...") and opens a Gemini Live session (ai.live.connect) with that prompt, audio-in/audio-out enabled, and transcription turned on for both sides.
Once Gemini's session opens, backend sends {"type":"ready"} down the WebSocket — the frontend only starts streaming mic audio after seeing this.
3. The conversation itself
Mic → Gemini: every ~90ms, the browser grabs a chunk of raw mic audio (ScriptProcessorNode), downsamples it to 16kHz PCM16, base64-encodes it, and sends it over the WebSocket. Backend forwards each chunk straight into the Gemini Live session (session.sendRealtimeInput).
Gemini → speakers: Gemini streams back synthesized speech audio (24kHz PCM16). Backend relays each chunk to the frontend, which schedules them back-to-back on an AudioContext for gapless playback (pcmPlayer.ts) — that's the AI's voice you hear.
Transcripts: Gemini also streams back text transcripts of both what the candidate said and what it said. The backend buffers these per-speaker and writes a Message row (type User or Assistant) to Postgres each time a turn completes — this is how the chat history gets built without a separate STT service.
The two pulsing orbs on screen are just live volume meters (RMS of the mic stream and the AI's audio stream) driving the "who's speaking" visual.
4. Ending and scoring
Candidate clicks "End interview" → frontend closes the WebSocket → backend closes the Gemini session and flushes any last buffered transcript → navigates to /result/:id.
GET /api/v1/result/:interviewId fetches all saved Message rows and, if not already scored, makes one non-realtime Gemini text call (calculateResult in result.ts) — feeds it the full transcript, asks for {score, feedback} as structured JSON — then marks the interview Done and stores the result.
So there are really two separate Gemini touchpoints: Gemini Live for the real-time spoken conversation, and one plain Gemini text call afterward for grading the transcript.

<img width="816" height="1056" alt="Main@1x" src="https://github.com/user-attachments/assets/0300e4d5-da0a-4175-916f-dd19ad0462e3" />
<img width="816" height="1056" alt="Conversation@1x" src="https://github.com/user-attachments/assets/5befdfab-6d34-4f90-9b52-59c585907f5f" />
<img width="816" height="1056" alt="Scoring@1x" src="https://github.com/user-attachments/assets/6b3fecfe-1790-4f80-956c-19384b9af518" />
