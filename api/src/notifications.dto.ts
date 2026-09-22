import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';
import { Role } from './common';

export const notificationTypes = ['lesson_reminder', 'lesson_rescheduled', 'lesson_cancelled', 'test_assigned', 'result_published'] as const;
export type NotificationType = typeof notificationTypes[number];
export class NotificationQueryDto extends ConnectionPageDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) override limit = 20;
  @ApiPropertyOptional({ default: false })
  @Transform(({ value }: { value: unknown }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean() unreadOnly = false;
}
export class NotificationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: notificationTypes }) type!: NotificationType;
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) recipientRole!: Role;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['lessons', 'tests'] }) target!: 'lessons' | 'tests';
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) readAt!: string | null;
}
export class NotificationPage {
  @ApiProperty({ type: [NotificationView] }) items!: NotificationView[];
  @ApiProperty() total!: number;
  @ApiProperty() unreadTotal!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class NotificationReadView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) readAt!: string;
}
export class NotificationPreferenceDto {
  @ApiProperty() @IsBoolean() inApp!: boolean;
  @ApiProperty() @IsBoolean() email!: boolean;
  @ApiProperty({ minimum: 0, maximum: 2147483646 }) @IsInt() @Min(0) @Max(2147483646) version!: number;
}
export class NotificationPreferenceView extends NotificationPreferenceDto {
  @ApiProperty({ enum: notificationTypes }) type!: NotificationType;
}
export class NotificationPreferenceList {
  @ApiProperty({ type: [NotificationPreferenceView] }) items!: NotificationPreferenceView[];
}
