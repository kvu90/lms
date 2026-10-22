import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function HomePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>LMS</CardTitle>
          <CardDescription>
            TypeScript LMS — Moodle core business equivalent. Frontend consumes the
            REST/OpenAPI backend via the shared @lms/contracts package.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button asChild>
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/health">Check API health</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
