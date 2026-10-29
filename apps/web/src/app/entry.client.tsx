import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

/**
 * Điểm vào phía trình duyệt (React Router framework mode): giữ
 * StrictMode như bản thư viện trước đây để hành vi render hai lần ở môi
 * trường dev bắt lỗi sớm, bọc trong startTransition như mẫu chính thức.
 */
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
