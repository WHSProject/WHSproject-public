import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  @Get('live')
  live(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): HealthResponse {
    return { status: 'ok' };
  }
}
