-- Replace githubMetadata (Json) with resumeText (String).
-- Existing rows are backfilled to '' since they predate resume-based interviews.
ALTER TABLE "Interview" ADD COLUMN "resumeText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Interview" DROP COLUMN "githubMetadata";
ALTER TABLE "Interview" ALTER COLUMN "resumeText" DROP DEFAULT;
