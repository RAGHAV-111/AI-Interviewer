import express from "express";
import multer from "multer";
import { extractResumeText } from "./resume";
import cors from "cors";
import { prisma } from "./db";
import { registerLiveBridge } from "./live";
import { calculateResult } from "./result";

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

app.post("/api/v1/pre-interview", upload.single("resume"), async (req, res) => {
    if (!req.file || req.file.mimetype !== "application/pdf") {
        res.status(411).json({
            message: "Please upload a resume as a PDF file"
        });
        return
    }

    const resumeText = await extractResumeText(req.file.buffer);

    if (!resumeText) {
        res.status(411).json({
            message: "Couldn't read any text from that PDF"
        });
        return
    }

    const interview = await prisma.interview.create({
        data: {
            resumeText,
            status: "Pre"
        }
    })

    res.json({ id: interview.id });
})

app.get("/api/v1/result/:interviewId", async (req, res) => {
  const interview = await prisma.interview.findFirst({
    where: {
      id: req.params.interviewId
    },
    include: {
      conversations: true
    }
  })

  if (!interview) {
    res.status(411).json({
      message: "Interview not found"
    })
    return 
  }

  res.json({
    score: interview?.score,
    feedback: interview?.feedback,
    transcript: interview?.conversations.map(c => ({
      type: c.type,
      content: c.message,
      createdAt: c.createdAt
    })),
    status: interview.status
  })

  // TODO: Should add some sort of a lock here.
  if (interview.status != "Done") {
    const result = await calculateResult(interview.conversations)

    await prisma.interview.update({
      where: {
        id: req.params.interviewId
      },
      data: {
        status: "Done",
        feedback: result.feedback,
        score: result.score
      }
    })
  }
})

const server = app.listen(3001);
registerLiveBridge(server);
