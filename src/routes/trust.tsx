import { createFileRoute, Link } from "@tanstack/react-router";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/trust")({
  head: () => ({
    meta: [
      { title: "Trust & Security · JellyBean" },
      {
        name: "description",
        content:
          "How JellyBean handles access control, customer data, storage, and privacy.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TrustPage,
});

function TrustPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-foreground">
      <ThemeToggle className="fixed right-4 top-4 z-20 h-10 w-10 justify-center border border-border bg-card/80 p-0 shadow-sm backdrop-blur-xl [&>span]:hidden" />
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Trust & Security</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This page is maintained by the JellyBean team to answer common
          questions about how the app protects customer and lead data. It is
          app-owned editable content, not an independent certification or audit.
          Some controls are provided by the underlying Lovable platform — using
          those controls is not a Lovable certification of this app.
        </p>
      </header>

      <Section title="Access & authentication">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            The CRM is a private internal tool. Access requires an account
            created by an administrator — there is no public sign-up.
          </li>
          <li>
            Permissions are role-based (admin, sub-admin, CS, scraping,
            maturing, account handler). Each role only sees the data it needs.
          </li>
          <li>
            Administrators can require a one-time code in addition to the
            password for sensitive logins.
          </li>
        </ul>
      </Section>

      <Section title="Hosting & platform">
        <p>
          The application runs on the Lovable platform. Traffic is served over
          HTTPS, and database access is mediated by row-level security rules
          that scope each request to the signed-in user&apos;s role. The Lovable
          platform manages the underlying infrastructure; this app is
          responsible for its own data model, access rules, and content.
        </p>
      </Section>

      <Section title="Customer & lead data">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Lead records (names, phone numbers, areas, notes) are only readable
            by the assigned CS user and authorized admins.
          </li>
          <li>
            Reporting endpoints that include team members&apos; names and
            emails are restricted to admin and sub-admin roles.
          </li>
          <li>
            Duplicate-phone lookups can only be invoked by signed-in users with
            a CRM role.
          </li>
        </ul>
      </Section>

      <Section title="File attachments">
        <p>
          Photos and files attached to leads are stored in a private bucket.
          Only authenticated users with a CRM role can read attachments;
          unauthenticated visitors cannot list or download them.
        </p>
      </Section>

      <Section title="Subprocessors & integrations">
        <ul className="list-disc space-y-2 pl-5">
          <li>Lovable Cloud / Supabase — application database, authentication, storage.</li>
          <li>Lovable AI Gateway — model access used for lead categorization helpers.</li>
        </ul>
        <p className="mt-2 text-sm text-muted-foreground">
          Contact the app owner for an up-to-date list of integrations enabled
          for your workspace.
        </p>
      </Section>

      <Section title="Retention & deletion">
        <p>
          Lead and activity data is retained for as long as the workspace owner
          requires it for operations. Administrators can delete leads and
          attachments from within the app. For bulk deletion or a full data
          export, contact the app owner.
        </p>
      </Section>

      <Section title="Security contact">
        <p>
          To report a suspected vulnerability or a data concern, contact the
          workspace administrator. Provide steps to reproduce and any relevant
          screenshots; do not include real customer data in the report.
        </p>
      </Section>

      <Section title="Shared responsibility">
        <p>
          The Lovable platform provides infrastructure, authentication
          primitives, and storage controls. The workspace owner is responsible
          for who is invited, what roles they hold, what is uploaded, and how
          exported data is handled outside the app. Customers using the leads
          handled in this CRM are responsible for their own data-handling
          obligations downstream.
        </p>
      </Section>

      <p className="mt-12 text-xs text-muted-foreground">
        This page describes current, enabled controls only. It is not a
        certification, audit report, or legal commitment.{" "}
        <Link to="/" className="underline">
          Return home
        </Link>
        .
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xl font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
