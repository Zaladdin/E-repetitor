import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsString, IsUUID, Length, Matches } from 'class-validator';
import { EmailDto, ResetDto } from './dto';

const tidy = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : value;
export class TemporaryStudentDto extends EmailDto {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(tidy) @IsString() @Length(2, 100, { message: 'Введите имя и фамилию (от 2 до 100 символов).' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Имя содержит недопустимые символы.' }) name!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') subjectId!: string;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Подтвердите, что у ученика ещё нет аккаунта.' }) noAccountConfirmed!: true;
}
export class ActivateInvitationDto extends ResetDto {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(tidy) @IsString() @Length(2, 100, { message: 'Введите имя и фамилию (от 2 до 100 символов).' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Имя содержит недопустимые символы.' }) name!: string;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Нужно принять условия использования.' }) acceptTerms!: true;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Нужно принять политику конфиденциальности.' }) acceptPrivacy!: true;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Подтвердите подключение к преподавателю и предмету.' }) acceptEnrollment!: true;
}
export class InvitationPreview {
  @ApiProperty() teacherName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export type TemporaryStudentStatus = 'pending' | 'activated' | 'expired' | 'revoked';
export class InvitationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending','accepted','expired','revoked'] }) status!: 'pending' | 'accepted' | 'expired' | 'revoked';
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['queued','sent','failed'] }) deliveryStatus!: 'queued' | 'sent' | 'failed';
  @ApiProperty() deliveryAttempts!: number;
}
export class TemporaryStudentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ enum: ['pending','activated','expired','revoked'] }) status!: TemporaryStudentStatus;
  @ApiPropertyOptional() studentPublicId?: string;
  @ApiProperty({ type: InvitationView }) invitation!: InvitationView;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class TemporaryStudentPage {
  @ApiProperty({ type: [TemporaryStudentView] }) items!: TemporaryStudentView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class TemporaryStudentMutation {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending','activated','expired','revoked'] }) status!: TemporaryStudentStatus;
}
export class InvitationActivationResult {
  @ApiProperty() message!: string;
}
