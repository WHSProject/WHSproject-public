import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { valid as validSemver } from 'semver';
import validateNpmPackageName = require('validate-npm-package-name');
import { z } from 'zod';

import { OsvFeedRefreshWorker } from '../osv/osv-feed-refresh.worker';

const refreshSchema = z.object({
  packageName: z.string().refine((value) => validateNpmPackageName(value).validForNewPackages),
  packageVersion: z.string().refine((value) => validSemver(value) === value),
}).strict();

@Controller('internal/v1/admin/feeds')
export class FeedAdminController {
  constructor(private readonly worker: OsvFeedRefreshWorker) {}

  @Post('refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refresh(@Body() body: unknown, @Headers('authorization') authorization?: string): ReturnType<OsvFeedRefreshWorker['forceRefresh']> {
    this.authorize(authorization);
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid feed refresh request');
    return this.worker.forceRefresh(parsed.data.packageName, parsed.data.packageVersion);
  }

  @Get('refresh/:jobId')
  status(@Param('jobId') jobId: string, @Headers('authorization') authorization?: string): ReturnType<OsvFeedRefreshWorker['forceRefresh']> {
    this.authorize(authorization);
    const job = this.worker.getJob(jobId);
    if (job === null) throw new NotFoundException('Feed refresh job was not found');
    return job;
  }

  private authorize(authorization?: string): void {
    const expected = process.env.SCANNER_ADMIN_TOKEN?.trim();
    if (expected !== undefined && expected !== '' && authorization !== `Bearer ${expected}`) {
      throw new ForbiddenException('Administrator authorization required');
    }
  }
}
