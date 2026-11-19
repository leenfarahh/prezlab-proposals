import Link from "next/link";
import { redirect } from "next/navigation";
import { UploadForm } from "@/components/upload-form";
import { getHubUser } from "@/lib/supabase/server";

export const metadata = { title: "Upload | Proposals Hub" };

export default async function UploadPage() {
  // Uploading is for people on the whitelist. Everyone else browses.
  if (!(await getHubUser()).isEditor) redirect("/");

  return (
    <>
      <Link href="/" className="back">
        ← All proposals
      </Link>
      <div className="narrow">
        <div className="page-head">
          <div>
            <h1>Upload a proposal</h1>
            <p className="muted">
              It starts as team only. Set the client link and password on the next page.
            </p>
          </div>
        </div>
        <section className="panel">
          <UploadForm />
        </section>
      </div>
    </>
  );
}
