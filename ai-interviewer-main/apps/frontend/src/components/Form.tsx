import { useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { toast } from "sonner";
import axios from "axios";
import { BACKEND_URL } from "@/lib/config";
import { useNavigate } from "react-router";
import { ArrowRight, FileText, Loader2, Mic, Upload } from "lucide-react";

export function Form() {
    const [file, setFile] = useState<File | null>(null);
    const [loading, setLoading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();

    function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const selected = e.target.files?.[0];
        if (!selected) return;
        if (selected.type !== "application/pdf") {
            toast("Please upload your resume as a PDF file");
            e.target.value = "";
            return;
        }
        setFile(selected);
    }

    async function onSubmit() {
        if (!file) {
            toast("Please upload your resume as a PDF file");
            return;
        }

        setLoading(true);
        try {
            const formData = new FormData();
            formData.set("resume", file);
            const response = await axios.post(`${BACKEND_URL}/api/v1/pre-interview`, formData);
            navigate(`/interview/${response.data.id}`);
        } catch (e) {
            toast("Something went wrong starting your interview. Please try again.");
            setLoading(false);
        }
    }

    return (
        <main className="flex h-screen w-screen items-center justify-center overflow-hidden px-6">
            <div className="flex w-full max-w-xl flex-col items-center text-center">
                <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                    <Mic className="size-3.5 text-primary" />
                    Voice-based technical interview
                </span>

                <h1 className="bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
                    AI Interview Kickstart
                </h1>
                <p className="mt-4 max-w-md text-balance text-base text-muted-foreground">
                    Upload your resume and start a live, voice-driven interview tailored to
                    your work. Get instant feedback when you're done.
                </p>

                <div className="mt-10 w-full">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/pdf"
                        onChange={onFileChange}
                        disabled={loading}
                        className="hidden"
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={loading}
                        className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-4 text-left shadow-sm backdrop-blur transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
                    >
                        <div className="flex items-center text-muted-foreground">
                            {file ? <FileText className="size-5 text-primary" /> : <Upload className="size-5" />}
                        </div>
                        <span className="flex-1 truncate text-sm">
                            {file ? file.name : "Choose your resume (PDF)"}
                        </span>
                    </button>

                    <Button
                        disabled={loading}
                        onClick={onSubmit}
                        size="lg"
                        className="mt-3 w-full gap-2"
                    >
                        {loading ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                Starting
                            </>
                        ) : (
                            <>
                                Start interview
                                <ArrowRight className="size-4" />
                            </>
                        )}
                    </Button>

                    <p className="mt-3 text-xs text-muted-foreground">
                        We'll ask for microphone access once your interview begins.
                    </p>
                </div>
            </div>
        </main>
    );
}
