import { Module } from '@nestjs/common';
import { SdkController } from './sdk.controller';

/**
 * SdkModule — serves the public tracker bundle under /sdk/v1/*.
 *
 * Pure static-file controller, no providers. Registered in AppModule and
 * mounted at the application root (not under /api) so customer sites can
 * embed `<script src="https://analytics-engine.app.veridian.site/sdk/v1/tracker.js">`
 * without an API prefix in the path.
 */
@Module({
  controllers: [SdkController],
})
export class SdkModule {}
