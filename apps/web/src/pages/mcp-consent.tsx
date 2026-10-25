import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';

/**
 * Trang đồng ý (consent) cho luồng uỷ quyền MCP (lát MCP-1, issue
 * #163) — `consentPage` của máy chủ OAuth Better Auth.
 *
 * AS chuyển trình duyệt tới đây kèm chuỗi query authorize ĐÃ KÝ.
 * Trang hiển thị tên client (lấy từ `/oauth2/public-client` bằng
 * chính phiên BA) + danh sách scope xin cấp dạng tích chọn. Scope
 * `lms.questions.write` (phát hành câu hỏi) KHÔNG tích sẵn — giáo
 * viên phải chủ động bật. Khi bấm đồng ý/từ chối, trang POST về
 * `/oauth2/consent` kèm `oauth_query` nguyên văn và đi tiếp theo
 * đúng `url` máy chủ trả về (không tự ghép redirect_uri — bài học
 * CVE-2026-67337 ghi trong addendum của issue).
 */

/** Nhãn tiếng Việt + mức cảnh báo cho từng scope MCP. */
const SCOPE_LABELS: Record<string, { label: string; sensitive?: boolean }> = {
  'lms.questions.read': { label: 'Xem ngân hàng câu hỏi: danh sách bank, thư mục, tìm và đọc câu hỏi' },
  'lms.questions.draft': { label: 'Tạo câu hỏi BẢN NHÁP trong ngân hàng cá nhân của bạn (chưa dùng được cho tới khi bạn duyệt)' },
  'lms.questions.write': {
    label: 'PHÁT HÀNH câu hỏi: chuyển bản nháp của bạn thành câu hỏi chính thức dùng được trong đề thi',
    sensitive: true,
  },
  'lms.banks.contribute': { label: 'Đề xuất đóng góp câu hỏi đã phát hành của bạn lên ngân hàng chung (vẫn cần người duyệt phía bank chung)' },
};

interface ConsentContext {
  clientId: string;
  clientName: string;
  scopes: string[];
  /** Chuỗi query authorize nguyên văn để gửi lại cho AS. */
  oauthQuery: string;
}

function readConsentContext(): ConsentContext | null {
  const search = window.location.search.replace(/^\?/, '');
  const params = new URLSearchParams(search);
  // AS có thể gói chuỗi authorize vào một tham số oauth_query duy
  // nhất, hoặc trải phẳng các tham số lên URL của trang này — đọc cả hai.
  const packed = params.get('oauth_query');
  const inner = packed ? new URLSearchParams(packed) : params;
  const clientId = inner.get('client_id') ?? params.get('client_id');
  if (!clientId) return null;
  const scopeParam = inner.get('scope') ?? params.get('scope') ?? '';
  return {
    clientId,
    clientName: clientId,
    scopes: scopeParam.split(' ').filter(Boolean),
    oauthQuery: packed ?? search,
  };
}

export default function McpConsentPage() {
  const [context, setContext] = useState<ConsentContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const parsed = readConsentContext();
    if (!parsed) {
      setLoadError('Liên kết uỷ quyền không hợp lệ (thiếu thông tin ứng dụng). Hãy bắt đầu lại từ ứng dụng AI của bạn.');
      return;
    }
    setContext(parsed);
    // Mọi scope NGOẠI TRỪ write được tích sẵn; write phải chủ động bật.
    setSelected(new Set(parsed.scopes.filter((scope) => scope !== 'lms.questions.write')));
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/auth/oauth2/public-client?client_id=${encodeURIComponent(parsed.clientId)}`,
          { credentials: 'include' },
        );
        if (res.status === 401) {
          // Chưa có phiên BA → quay về trang đăng nhập, giữ nguyên query.
          window.location.assign(`/mcp-login${window.location.search}`);
          return;
        }
        const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
        if (res.ok && body && typeof body.name === 'string' && body.name.length > 0) {
          setContext((current) => (current ? { ...current, clientName: body.name as string } : current));
        }
      } catch {
        // Không lấy được tên client thì hiển thị client_id — vẫn dùng được.
      }
    })();
  }, []);

  async function submit(accept: boolean) {
    if (!context) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/v1/auth/oauth2/consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accept,
          ...(accept ? { scope: [...selected].join(' ') } : {}),
          oauth_query: context.oauthQuery,
        }),
      });
      const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
      if (res.ok && body && typeof body.url === 'string') {
        // Đi tiếp theo URL máy chủ trả — không tự ghép redirect.
        window.location.assign(body.url);
        return;
      }
      setSubmitError('Máy chủ không chấp nhận lựa chọn này. Hãy thử lại hoặc từ chối và bắt đầu lại từ ứng dụng AI.');
      setBusy(false);
    } catch {
      setSubmitError('Không kết nối được máy chủ. Thử lại sau ít phút.');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Uỷ quyền cho ứng dụng AI</CardTitle>
          <CardDescription>
            {context
              ? `Ứng dụng "${context.clientName}" xin được thay bạn thực hiện các việc sau trong LMS. Chỉ cấp những quyền bạn thật sự cần — bạn thu hồi được bằng cách ngừng kết nối trong ứng dụng.`
              : 'Đang tải thông tin uỷ quyền…'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : null}
          {context ? (
            <>
              <ul className="space-y-3">
                {context.scopes.map((scope) => {
                  const known = SCOPE_LABELS[scope];
                  return (
                    <li key={scope} className="flex items-start gap-3">
                      <input
                        id={`scope-${scope}`}
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={selected.has(scope)}
                        onChange={(event) => {
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(scope);
                            else next.delete(scope);
                            return next;
                          });
                        }}
                      />
                      <label htmlFor={`scope-${scope}`} className="text-sm leading-snug">
                        {known ? known.label : scope}
                        {known?.sensitive ? (
                          <span className="mt-1 block font-medium text-destructive">
                            Quyền mạnh — chỉ bật khi bạn tin tưởng ứng dụng này.
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {submitError ? (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}
              <div className="flex gap-3">
                <Button className="flex-1" disabled={busy || selected.size === 0} onClick={() => void submit(true)}>
                  {busy ? 'Đang xử lý…' : 'Đồng ý uỷ quyền'}
                </Button>
                <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void submit(false)}>
                  Từ chối
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
