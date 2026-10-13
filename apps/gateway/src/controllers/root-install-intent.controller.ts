import {
  BadRequestException,
  Body,
  Controller,
  Post,
} from '@nestjs/common';

import { toHttpException } from '../http/to-http-exception';
import { PackageNameParserService } from '../services/package-name-parser.service';
import { RootInstallIntentService } from '../services/root-install-intent.service';

interface RootInstallIntentRequest {
  packageName?: unknown;
}

function parseRequestBody(rawBody: unknown): RootInstallIntentRequest {
  let body: unknown = rawBody;

  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadRequestException('request body must be valid JSON');
    }
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new BadRequestException('request body must be valid JSON');
    }
  }

  if (
    typeof body !== 'object'
    || body === null
    || Array.isArray(body)
  ) {
    throw new BadRequestException('request body must be a JSON object');
  }

  return body as RootInstallIntentRequest;
}

@Controller('internal/v1/install-intents')
export class RootInstallIntentController {
  constructor(
    private readonly packageNameParserService: PackageNameParserService,
    private readonly rootInstallIntentService: RootInstallIntentService,
  ) {}

  @Post()
  register(
    @Body() rawBody: unknown,
  ): { registered: true; packageName: string } {
    const body = parseRequestBody(rawBody);

    let packageName: string;

    try {
      packageName =
        this.packageNameParserService.parse(body.packageName).packageName;
    } catch (error) {
      throw toHttpException(error);
    }

    this.rootInstallIntentService.register(packageName);

    return {
      registered: true,
      packageName,
    };
  }
}
