import { useEffect, useState } from 'react';
import { IconBuildingCommunity, IconCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MyTenant } from '@lms/contracts';

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@lms/ui/components/dropdown-menu';
import { fetchMyTenants, switchTenant } from '#lib/tenants';
import '../i18n';

/**
 * Mục chuyển không gian làm việc trong menu người dùng (TENANT-0,
 * #168): chỉ hiện khi người dùng là thành viên active của TỪ HAI tenant
 * trở lên. Tenant hiệu lực được đánh dấu; chọn tenant khác là chuyển
 * phiên thật ở máy chủ (token mới mang claim `tid` của tenant đích).
 */
export function TenantSwitcherMenu() {
  const { t } = useTranslation('app');
  const [tenants, setTenants] = useState<MyTenant[]>([]);
  useEffect(() => {
    let alive = true;
    fetchMyTenants()
      .then((rows) => {
        if (alive) setTenants(rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (tenants.length < 2) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('navTenant')}</DropdownMenuLabel>
        {tenants.map((tenant) => (
          <DropdownMenuItem
            key={tenant.id}
            disabled={tenant.active}
            onClick={() => {
              if (!tenant.active) void switchTenant(tenant.id);
            }}
          >
            <IconBuildingCommunity />
            <span className="flex-1 truncate">{tenant.name}</span>
            {tenant.active ? <IconCheck className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}
