import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { UsersModule } from '../users/users.module';
import { SeedService } from './seed.service';

@Module({ imports: [AccessModule, UsersModule], providers: [SeedService] })
export class SeedModule {}
