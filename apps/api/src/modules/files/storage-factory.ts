import type { ConfigService } from '@nestjs/config';
import { LocalObjectStorage, type ObjectStorage } from './storage';
import { S3ObjectStorage } from './storage-s3';

/**
 * Driver selection for the files physical layer, by env only:
 * FILE_STORAGE_DRIVER=local (default — current behaviour unchanged when
 * the variable is unset) or =s3 (durable object storage). An unknown
 * value fails fast at boot instead of silently falling back.
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
