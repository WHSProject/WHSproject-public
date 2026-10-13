import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FeedAdminController } from '../src/api/feed-admin.controller';
import type { OsvFeedRefreshWorker } from '../src/osv/osv-feed-refresh.worker';

const authorization = 'Bearer fixture-token';

it('requires the configured administrator token before accepting a refresh', () => {
  const previous = process.env.SCANNER_ADMIN_TOKEN;
  process.env.SCANNER_ADMIN_TOKEN = 'fixture-token';
  try {
    const worker = { forceRefresh: jest.fn(), getJob: jest.fn() } as unknown as OsvFeedRefreshWorker;
    const controller = new FeedAdminController(worker);
    expect(() => controller.refresh({ packageName: 'demo', packageVersion: '1.0.0' })).toThrow(ForbiddenException);
    expect(() => controller.refresh({ packageName: 'demo', packageVersion: '1.0.0' }, 'Bearer wrong')).toThrow(ForbiddenException);
    expect(worker.forceRefresh).not.toHaveBeenCalled();
    expect(() => controller.refresh({ packageName: 'bad name', packageVersion: '1.0.0' }, authorization)).toThrow(BadRequestException);
    expect(worker.forceRefresh).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.SCANNER_ADMIN_TOKEN;
    else process.env.SCANNER_ADMIN_TOKEN = previous;
  }
});

it('returns a job and its state, reusing the worker response for duplicate requests', () => {
  const previous = process.env.SCANNER_ADMIN_TOKEN;
  process.env.SCANNER_ADMIN_TOKEN = 'fixture-token';
  try {
    const job = { jobId: 'job-1', status: 'QUEUED' };
    const worker = { forceRefresh: jest.fn().mockReturnValue(job), getJob: jest.fn().mockReturnValue({ ...job, status: 'SUCCEEDED' }) } as unknown as OsvFeedRefreshWorker;
    const controller = new FeedAdminController(worker);
    const request = { packageName: 'demo', packageVersion: '1.0.0' };
    expect(controller.refresh(request, authorization)).toEqual(job);
    expect(controller.refresh(request, authorization)).toEqual(job);
    expect(controller.status('job-1', authorization)).toMatchObject({ status: 'SUCCEEDED' });
    expect(() => controller.status('job-1')).toThrow(ForbiddenException);
    (worker.getJob as jest.Mock).mockReturnValue(null);
    expect(() => controller.status('missing', authorization)).toThrow(NotFoundException);
  } finally {
    if (previous === undefined) delete process.env.SCANNER_ADMIN_TOKEN;
    else process.env.SCANNER_ADMIN_TOKEN = previous;
  }
});
