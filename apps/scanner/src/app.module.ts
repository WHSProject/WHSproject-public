import { Module } from '@nestjs/common';

import { HealthController } from './api/health.controller';
import { ScanController } from './api/scan.controller';
import { ScannerModule } from './scanner/scanner.module';

@Module({
  imports: [ScannerModule],
  controllers: [HealthController, ScanController],
})
export class AppModule {}
