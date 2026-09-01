import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ToolsService } from './tools.service';
import { AlertEngine } from './alert.engine';
import { CreateToolDto } from './dto/create-tool.dto';
import { UpdateToolDto } from './dto/update-tool.dto';

@Controller('tools')
@UseGuards(JwtAuthGuard)
export class ToolsController {
  constructor(
    private tools: ToolsService,
    private alerts: AlertEngine,
  ) {}

  @Get()
  list(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('paymentKind') paymentKind?: string,
  ) {
    return this.tools.list(req.user.orgId, { category, paymentKind });
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateToolDto) {
    return this.tools.create(req.user.orgId, req.user.sub, dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.tools.findOne(id, req.user.orgId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Req() req: any, @Body() dto: UpdateToolDto) {
    return this.tools.update(id, req.user.orgId, req.user.sub, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.tools.softDelete(id, req.user.orgId, req.user.sub);
  }

  @Post(':id/test-alert')
  @HttpCode(200)
  async testAlert(@Param('id') id: string, @Req() req: any) {
    await this.alerts.evaluateThreshold(id);
    return { message: 'Test alert sent' };
  }
}
