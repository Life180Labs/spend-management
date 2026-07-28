import { BadRequestException, Controller, Get, Put, Delete, Post, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IntegrationsService } from './integrations.service';

@Controller('integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  constructor(private integrations: IntegrationsService) {}

  // Must be before :toolId routes or NestJS matches "preview-limits" as a toolId
  @Post('preview-limits')
  previewLimits(@Body() body: any) {
    return this.integrations.previewLimits(body.provider, body.config);
  }

  @Get(':toolId')
  get(@Param('toolId') toolId: string, @Req() req: any) {
    return this.integrations.get(toolId, req.user.orgId);
  }

  @Put(':toolId')
  upsert(@Param('toolId') toolId: string, @Body() body: any, @Req() req: any) {
    return this.integrations.upsert(toolId, req.user.orgId, body);
  }

  @Delete(':toolId')
  remove(@Param('toolId') toolId: string, @Req() req: any) {
    return this.integrations.remove(toolId, req.user.orgId);
  }

  @Get(':toolId/limits')
  fetchLimits(@Param('toolId') toolId: string, @Req() req: any) {
    return this.integrations.fetchLimits(toolId, req.user.orgId);
  }

  @Post(':toolId/sync')
  syncNow(@Param('toolId') toolId: string, @Req() req: any) {
    return this.integrations.syncNow(toolId, req.user.orgId);
  }

  @Get(':toolId/history')
  getUsageHistory(
    @Param('toolId') toolId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() req: any,
  ) {
    const startDate = new Date(from);
    const endDate = new Date(to);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('from/to must be valid ISO dates');
    }
    if (startDate > endDate) {
      throw new BadRequestException('from must be before to');
    }
    return this.integrations.getUsageHistory(toolId, req.user.orgId, startDate, endDate);
  }
}
