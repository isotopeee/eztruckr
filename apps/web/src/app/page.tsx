import { HealthStatusCard } from '@/components/health-status-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">EZTruckr</h1>
        <p className="text-muted-foreground">
          Trucking management for Philippine hauling operations.
        </p>
      </header>

      <HealthStatusCard />

      <Card>
        <CardHeader>
          <CardTitle>Phase 1 — Foundation</CardTitle>
          <CardDescription>The scaffold is up. Domain modules land in Phase 2.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
            <li>Turborepo with web, api, db, types and config workspaces</li>
            <li>PostgreSQL and MinIO via docker compose</li>
            <li>Prisma with automatic createdBy / updatedBy stamping</li>
            <li>NestJS with health check, validated config and a global Zod pipe</li>
            <li>Next.js with Tailwind, shadcn/ui and TanStack Query</li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
