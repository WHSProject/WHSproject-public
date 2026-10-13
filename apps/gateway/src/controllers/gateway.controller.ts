import {Controller, Get} from '@nestjs/common';

// Gateway 프로세스의 생존 확인. Scanner·Decision DB 상태는 확인하지 않는다.
@Controller()
export class GatewayController {
  @Get('health')
  health(): { status: string; service: string } {
    return {
      status: 'ok',
      service: 'gateway',
    };
  }
}
