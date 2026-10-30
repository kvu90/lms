import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsFilter } from './problem-details.filter';

function runFilter(exception: unknown) {
  const filter = new ProblemDetailsFilter();
  const json = vi.fn();
  const type = vi.fn().mockReturnValue({ json });
  const status = vi.fn().mockReturnValue({ type });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/v1/things/1' }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return { status, json };
}

describe('Khối ProblemDetailsFilter', () => {
  it('định dạng 404 thành problem+json theo RFC 7807', () => {
    const { status, json } = runFilter(new NotFoundException('thing missing'));
    expect(status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({
      type: 'about:blank', title: 'Not Found', status: 404,
      detail: 'thing missing', code: 'http.not_found', instance: '/api/v1/things/1',
    });
  });

  it('định dạng lỗi validation kèm mảng errors', () => {
    const { json } = runFilter(
      new BadRequestException({ message: ['name is required', 'age must be a number'] }),
    );
    const body = json.mock.calls[0][0];
    expect(body.status).toBe(400);
    expect(body.code).toBe('http.validation_failed');
    expect(body.errors).toHaveLength(2);
  });

  it('giấu chi tiết nội bộ với lỗi chưa biết (500)', () => {
    const { json } = runFilter(new Error('db password is hunter2'));
    const body = json.mock.calls[0][0];
    expect(body.status).toBe(500);
    expect(body.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
