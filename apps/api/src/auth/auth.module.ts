import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthService } from './auth.service';

/**
 * Global so the session middleware and every guard can reach `AuthService`
 * without each feature module re-importing it.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
