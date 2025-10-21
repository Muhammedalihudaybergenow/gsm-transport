import { Module } from '@nestjs/common';
import { AuthService } from './services';
import { BasicAuthGuard } from './guards';
import { BasicStrategy } from './strategies';
import { AuthController } from './controllers/auth.controller';

@Module({
  controllers: [AuthController],
  providers: [AuthService, BasicAuthGuard, BasicStrategy],
})
export class AuthModule {}
