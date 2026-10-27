import type { ConfigService } from '@nestjs/config';
import { LocalObjectStorage, type ObjectStorage } from './storage';
import { S3ObjectStorage } from './storage-s3';

/**
 * Lựa chọn driver cho tầng vật lý của file, chỉ theo env:
 * FILE_STORAGE_DRIVER=local (mặc định — hành vi hiện tại không đổi khi
 * biến chưa được đặt) hoặc =s3 (lưu trữ đối tượng bền vững). Một giá trị lạ
 * sẽ fail fast lúc khởi động thay vì âm thầm fallback.
 */
/**
 * Chọn adapter kho file theo env FILE_STORAGE_DRIVER; giá trị lạ thì fail-fast, không rơi im lặng về local.
 */
export function createObjectStorage(config: ConfigService): ObjectStorage {
  const driver = (config.get<string>('FILE_STORAGE_DRIVER') ?? 'local').trim().toLowerCase();
  switch (driver) {
    case 'local': return new LocalObjectStorage(config);
    case 's3': return new S3ObjectStorage(config);
    default: throw new Error(`Unknown FILE_STORAGE_DRIVER "${driver}" — expected "local" or "s3"`);
  }
}
