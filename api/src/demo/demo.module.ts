import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

/**
 * DemoModule — public demo instance support.
 *
 * AuthModule is imported (not JwtModule directly) so the controller can inject
 * JwtService to mint anonymous tokens for `POST /api/demo.login`. The JWT
 * factory (secret = ENCRYPTION_KEY, expiry = JWT_EXPIRES_IN) lives in
 * AuthModule and is re-exported there — see AuthModule.exports.
 */
@Module({
  imports: [AuthModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
