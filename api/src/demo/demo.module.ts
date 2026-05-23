import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { RobotsController } from './robots.controller';

/**
 * DemoModule — public demo instance support.
 *
 * AuthModule is imported (not JwtModule directly) so the controller can inject
 * JwtService to mint anonymous tokens for `POST /api/demo.login`. The JWT
 * factory (secret = ENCRYPTION_KEY, expiry = JWT_EXPIRES_IN) lives in
 * AuthModule and is re-exported there — see AuthModule.exports.
 *
 * RobotsController is registered here because the indexing policy is a
 * function of the demo flag (BUG-11). It is mounted at the application
 * root (not under /api) so it intercepts /robots.txt before the static
 * server falls back to the on-disk file.
 */
@Module({
  imports: [AuthModule],
  controllers: [DemoController, RobotsController],
  providers: [DemoService],
})
export class DemoModule {}
