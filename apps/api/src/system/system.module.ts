import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

/** First-run setup. Provisioning itself stays in `UsersModule`. */
@Module({
  imports: [UsersModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
