import { Test } from '@nestjs/testing';

import { GatewayModule } from '../src/gateway.module';
import { createGatewayApplication } from '../src/main';
import { TarballAnalysisService } from "../src/services/tarball-analysis.service";

describe('GatewayModule', () => {
  it('registers the Gateway service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    expect(moduleRef.get(TarballAnalysisService)).toBeDefined();

    await moduleRef.close();
  });

  it('creates the application with the Fastify adapter', async () => {
    const app = await createGatewayApplication();

    await app.init();

    expect(app.getHttpAdapter().getType()).toBe('fastify');

    await app.close();
  });
});
