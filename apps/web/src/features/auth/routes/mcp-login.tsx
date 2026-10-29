import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { ErrorAlert } from '#components/error-alert';

/**
 * Trang đăng nhập cho luồng uỷ quyền MCP (lát MCP-1, issue #163).
 *
 * Đây KHÔNG phải trang đăng nhập chính của LMS: nó là `loginPage` mà
 * máy chủ OAuth (plugin mcp() của Better Auth) chuyển tới khi client
 * AI mở luồng authorize mà trình duyệt chưa có phiên Better Auth.
 * Trang chỉ làm hai việc: đăng nhập bằng username/mật khẩu qua
 * endpoint của Better Auth (cookie phiên do BA đặt), rồi quay lại
 * `/oauth2/authorize` với NGUYÊN VĂN chuỗi query ban đầu để AS nối
 * tiếp luồng (chuỗi đó đã được AS ký — không tự sửa hay ghép thêm).
 *
 * Tài khoản đã bật xác thực hai lớp: đáp ứng đăng nhập mang
 * `twoFactorRedirect` và CHƯA có phiên nào (chỉ có cookie chờ bước
 * hai) — trang chuyển sang form nhập mã TOTP, gọi endpoint hoàn tất
 * bước hai để lấy cookie phiên rồi mới quay lại authorize. Bỏ qua
 * bước này (coi mọi đáp ứng 200 là đã đăng nhập) sẽ khiến authorize
 * đẩy về lại trang này vô hạn.
 */
export default function McpLoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  // Đã có phiên BA rồi thì khỏi đăng nhập lại: đi thẳng authorize.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
        const body = (await res.json().catch(() => null)) as { user?: unknown } | null;
        if (!cancelled && res.ok && body && typeof body === 'object' && body.user) {
          window.location.assign(`/api/v1/auth/oauth2/authorize${window.location.search}`);
          return;
        }
      } catch {
        // Không có phiên/không với tới được API → cứ hiện form đăng nhập.
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/sign-in/username', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setError('Đăng nhập không thành công. Kiểm tra lại tên đăng nhập và mật khẩu.');
        setBusy(false);
        return;
      }
      // Tài khoản có MFA: chưa có phiên — sang bước nhập mã TOTP,
      // authorize chỉ được quay lại sau khi bước hai qua.
      const body = (await res.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null;
      if (body && typeof body === 'object' && body.twoFactorRedirect) {
        setNeedsMfa(true);
        setBusy(false);
        return;
      }
      // Phiên BA đã được đặt cookie — quay lại authorize với query gốc.
      window.location.assign(`/api/v1/auth/oauth2/authorize${window.location.search}`);
    } catch {
      setError('Không kết nối được máy chủ. Thử lại sau ít phút.');
      setBusy(false);
    }
  }

  /** Bước hai MFA của luồng MCP: mã đúng → cookie phiên được đặt → quay lại authorize với query gốc. */
  async function onMfaSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/two-factor/verify-totp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      if (!res.ok) {
        setError('Mã xác thực không đúng hoặc đã hết hạn. Đăng nhập lại để nhận thử thách mới nếu mã vẫn bị từ chối.');
        setBusy(false);
        return;
      }
      window.location.assign(`/api/v1/auth/oauth2/authorize${window.location.search}`);
    } catch {
      setError('Không kết nối được máy chủ. Thử lại sau ít phút.');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Đăng nhập để uỷ quyền ứng dụng AI</CardTitle>
          <CardDescription>
            Một ứng dụng AI đang xin quyền truy cập ngân hàng câu hỏi thay bạn. Đăng nhập bằng tài khoản LMS
            của bạn để tiếp tục tới bước xác nhận quyền.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {checking ? (
            <p className="text-sm text-muted-foreground">Đang kiểm tra phiên đăng nhập…</p>
          ) : needsMfa ? (
            <form className="space-y-4" onSubmit={onMfaSubmit}>
              {error ? (
                <ErrorAlert variant="destructive">
                  {error}
                </ErrorAlert>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Tài khoản của bạn đã bật xác thực hai lớp. Nhập mã 6 số từ ứng dụng xác thực để tiếp tục.
              </p>
              <div className="space-y-2">
                <Label htmlFor="mcp-mfa-code">Mã xác thực</Label>
                <Input
                  id="mcp-mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Đang xác thực…' : 'Xác thực và tiếp tục'}
              </Button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              {error ? (
                <ErrorAlert variant="destructive">
                  {error}
                </ErrorAlert>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="mcp-username">Tên đăng nhập</Label>
                <Input
                  id="mcp-username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-password">Mật khẩu</Label>
                <Input
                  id="mcp-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Đang đăng nhập…' : 'Đăng nhập và tiếp tục'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
