import { Card, PageHeader } from "../components/ui";

export function Settings() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="space-y-4">
        <Card>
          <h2 className="font-semibold">Workspace</h2>
          <p className="mt-1 text-sm text-muted">Name, people and permissions.</p>
        </Card>
        <Card>
          <h2 className="font-semibold">Your data</h2>
          <p className="mt-1 text-sm text-muted">
            Export your automations at any time and run them yourself. No fees, no lock-in.
          </p>
        </Card>
      </div>
    </div>
  );
}
