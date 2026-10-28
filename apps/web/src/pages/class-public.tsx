import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { createClassFeePayment, fetchClassPublic, fetchPayment, type ClassFeePaymentView } from '#lib/classes';
import { queryKeys } from '#lib/query-keys';

/**
 * Trang CÔNG KHAI của lớp để mua gói học phí (CLASS-3, issue #184).
 *
 * Flow:
 *  1. Nạp gói công khai của lớp (`GET /classes/:id/public`) — server đã
 *     suy sẵn quan hệ của người gọi với lớp: trang chỉ dựng hiển thị
 *     theo `isMember` / `canPurchase` / `feeEnabled` / `status`, không
 *     tự diễn giải lại luật (quyền thật vẫn gác ở API).
 *  2. Chưa ghi danh + lớp đang bán gói → hiện học phí và nút thanh
 *     toán. Bấm nút = tạo payment `class_fee` (POST
 *     /payments/class-fee/:classId) rồi hiện mã VietQR + mã thanh
 *     toán để học sinh quét bằng ứng dụng ngân hàng.
 *  3. Sau khi có payment, trang poll trạng thái payment mỗi 3 giây:
 *     đối soát SePay khớp đủ 3 điều kiện ở phía API mới lật payment
 *     sang `succeeded` và kích hoạt ghi danh cấp lớp — trang thấy
 *     `succeeded` thì báo đã vào lớp và nạp lại gói công khai (lúc này
 *     `isMember` = true).
 *  4. Đã ghi danh ACTIVE → hiện trạng thái đã ghi danh + nút vào lớp,
 *     TUYỆT ĐỐI không hiện nút mua lại.
 *
 * Bất biến hiển thị: trang này không bao giờ tự ghi danh hay tự đánh
 * dấu đã thanh toán — mọi trạng thái đều đọc từ API.
 */
export function ClassPublicPage() {
  const { t, i18n } = useTranslation('app');
  const { id } = useParams<{ id: string }>();
  const classId = id ?? '';
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState<ClassFeePaymentView | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const publicQuery = useQuery({
    queryKey: queryKeys.classPublic(classId),
    queryFn: () => fetchClassPublic(classId),
    enabled: Boolean(classId),
  });

  // Poll trạng thái payment sau khi tạo: khoảng poll tính theo
  // trạng thái MỚI NHẤT đã biết (đáp ứng poll gần nhất; chưa có thì
  // bản tạo ban đầu trong state) — payment rời `pending` là poll
  // dừng hẳn. Bản cũ tính `enabled` theo object gốc trong state vốn
  // không bao giờ được cập nhật nên poll chạy vô thời hạn kể cả khi
  // payment đã `succeeded`.
  const statusQuery = useQuery({
    queryKey: queryKeys.payment(payment?.id ?? ''),
    queryFn: () => fetchPayment(payment!.id),
    enabled: Boolean(payment),
    refetchInterval: (query) => ((query.state.data?.status ?? payment?.status) === 'pending' ? 3000 : false),
  });
  const livePayment = statusQuery.data ?? payment;
  const succeeded = livePayment?.status === 'succeeded';

  const buyMutation = useMutation({
    mutationFn: () => createClassFeePayment(classId),
    onSuccess: (created) => {
      setPayError(null);
      setPayment(created);
    },
    onError: () => setPayError(t('classPublicPayFailed')),
  });

  // Payment đã khớp mà gói công khai chưa ghi nhận thành viên: nạp
  // lại gói công khai đúng MỘT lần cho mỗi payment để chuyển sang
  // trạng thái thành viên (server là nguồn sự thật của roster). Việc
  // nạp lại nằm trong effect — không gọi invalidate trong lúc
  // render — và ref ghi nhớ payment đã xử lý chặn vòng lặp nạp lại
  // khi server chưa kịp lật `isMember`.
  const refreshedPaymentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!succeeded || !publicQuery.data || publicQuery.data.isMember) return;
    if (!payment || refreshedPaymentRef.current === payment.id) return;
    refreshedPaymentRef.current = payment.id;
    void queryClient.invalidateQueries({ queryKey: queryKeys.classPublic(classId) });
  }, [succeeded, publicQuery.data, payment, queryClient, classId]);

  const pub = publicQuery.data;

  return (
    <PageShell width="narrow">
      <PageHeader title={pub?.name ?? t('classPublicFeeLabel')} description={pub?.schoolYear ?? undefined} />
      {publicQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : publicQuery.isError || !pub ? (
        <ErrorAlert variant="destructive">
          {t('classPublicLoadFailed')}
        </ErrorAlert>
      ) : (
        <Card>
          {/* Tên lớp chỉ hiện ở PageHeader phía trên — không lặp lại
              trong thẻ để trang có đúng một tiêu đề. */}
          <CardContent className="flex flex-col gap-4 pt-6">
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">{t('classPublicOwner', { name: pub.ownerName })}</p>
              {pub.description ? <p>{pub.description}</p> : null}
            </div>

            {pub.isMember || succeeded ? (
              <div className="flex flex-col gap-3">
                <ErrorAlert>
                  {succeeded ? t('classPublicPaySucceeded') : t('classPublicMember')}
                </ErrorAlert>
                <div>
                  <Link className={buttonVariants()} to={`/classes/${pub.classId}`}>
                    {t('classPublicGoToClass')}
                  </Link>
                </div>
              </div>
            ) : pub.status === 'archived' ? (
              <ErrorAlert>
                {t('classPublicArchived')}
              </ErrorAlert>
            ) : !pub.feeEnabled ? (
              <p className="text-sm text-muted-foreground">{t('classPublicNoFee')}</p>
            ) : livePayment ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm">{t('classPublicScanHint')}</p>
                {livePayment.vietqrPayload ? (
                  <QRCodeSVG value={livePayment.vietqrPayload} size={220} role="img" aria-label="VietQR" />
                ) : null}
                {livePayment.paymentCode ? (
                  <p className="text-sm">
                    {t('classPublicPaymentCode')}: <strong>{livePayment.paymentCode}</strong>
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">{t('classPublicPayPending')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-base">
                  {t('classPublicFeeLabel')}:{' '}
                  {/* Ghim locale theo ngôn ngữ giao diện: số tiền phải
                      phân nhóm nhất quán (vd 1.500.000 ở vi), không phụ
                      thuộc locale mặc định của máy chạy. */}
                  <strong>
                    {(pub.feeCost ?? 0).toLocaleString(i18n.language)} {pub.feeCurrency}
                  </strong>
                </p>
                <p className="text-sm text-muted-foreground">{t('classPublicBuyHint')}</p>
                {payError ? (
                  <ErrorAlert variant="destructive">
                    {payError}
                  </ErrorAlert>
                ) : null}
                <div>
                  <Button type="button" disabled={buyMutation.isPending} onClick={() => buyMutation.mutate()}>
                    {t('classPublicBuy')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

export default ClassPublicPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('classPublicTitle');
}
