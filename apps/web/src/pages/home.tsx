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
          <Button asChild>
            <Link to="/health">Check API health</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
