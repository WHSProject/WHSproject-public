import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
} from '@nestjs/common';
import { valid as validSemver } from 'semver';
import { parse as parseSri } from 'ssri';
import validateNpmPackageName = require('validate-npm-package-name');
import { z } from 'zod';

import { ScanService } from '../application/scan-service/scan.service';

const SCAN_BATCH_CONCURRENCY = 3;

function isValidNpmPackageName(value: string): boolean {
  return validateNpmPackageName(value).validForNewPackages;
}

function isExactSemver(value: string): boolean {
  return validSemver(value) === value;
}

function isSha512Sri(value: string): boolean {
  try {
    const parsed = parseSri(value, { strict: true });
    const algorithms = Object.keys(parsed);

    return algorithms.length === 1
      && algorithms[0] === 'sha512'
      && Object.values(parsed).some(
        (digests) => Array.isArray(digests) && digests.length > 0,
      );
  } catch {
    return false;
  }
}

const scanRequestSchema = z.object({
  requestId: z.string().uuid(),
  packages: z.array(z.object({
    packageName: z.string().refine(isValidNpmPackageName),
    version: z.string().refine(isExactSemver),
    integrity: z.string().refine(isSha512Sri),
  })).min(1),
});

type ScanBatchRequest = z.infer<typeof scanRequestSchema>;

@Controller('internal/v1/scans')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async scan(@Body() body: unknown): Promise<void> {
    const parsed = scanRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException('Invalid scan request');
    }

    await this.scanPackages(parsed.data);
  }

  private async scanPackages(request: ScanBatchRequest): Promise<void> {
    const packageErrors: unknown[] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= request.packages.length) return;

        const item = request.packages[index];
        if (item === undefined) return;
        try {
          const result = await this.scanService.scan({
            requestId: request.requestId,
            packageName: item.packageName,
            version: item.version,
            integrity: item.integrity,
          });

          if (result.status === 'FAILED' || result.status === 'TIMEOUT') {
            throw new Error(`Scan result is not authoritative: ${result.status}`);
          }
        } catch (error) {
          packageErrors.push(error);
        }
      }
    };

    const workerCount = Math.min(
      SCAN_BATCH_CONCURRENCY,
      request.packages.length,
    );
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );

    if (packageErrors.length > 0) {
      throw new InternalServerErrorException();
    }
  }
}
