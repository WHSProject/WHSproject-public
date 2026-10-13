import { Injectable } from '@nestjs/common';

import type { ScanResult } from '../domain/analysis.types';

@Injectable()
export class ScanHistoryService {
  private readonly results = new Map<string, ScanResult>();
  private readonly scanOrder: string[] = [];

  save(result: ScanResult): ScanResult {
    if (!this.results.has(result.scanId)) {
      this.scanOrder.push(result.scanId);
    }

    this.results.set(result.scanId, result);
    return result;
  }

  findByScanId(scanId: string): ScanResult | undefined {
    return this.results.get(scanId);
  }

  findByRequestId(requestId: string): ScanResult[] {
    return this.scanOrder
      .map((scanId) => this.results.get(scanId))
      .filter((result): result is ScanResult => result?.requestId === requestId);
  }
}
