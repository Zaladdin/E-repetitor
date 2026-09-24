import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsEmail, IsIn, IsString, Length, Matches, MaxLength, ValidateBy, ValidateIf } from 'class-validator';
import { Role } from './common';
import { isBirthDate, normalizePhone, phonePattern } from './teacher-profile';

const tidy = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : value;
const email = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const BirthDate = () => ValidateBy({ name: 'birthDate', validator: { validate: value => isBirthDate(value) } },
  { message: 'Укажите существующую дату рождения, не позднее сегодняшней.' });
const phoneMessage = 'Введите номер телефона с кодом страны, например +994 50 123 45 67.';

export class EmailDto {
  @ApiProperty({ example: 'teacher@example.com', maxLength: 254 })
  @Transform(email) @IsEmail({}, { message: 'Введите корректный email.' }) @MaxLength(254)
  email!: string;
}
export class LoginDto extends EmailDto {
  @ApiProperty({ format: 'password', minLength: 10, maxLength: 128 })
  @IsString() @Length(10, 128, { message: 'Пароль должен содержать от 10 до 128 символов.' })
  password!: string;
}
export class RegisterDto extends LoginDto {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(tidy) @IsString() @Length(2, 100, { message: 'Введите имя и фамилию (от 2 до 100 символов).' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Имя содержит недопустимые символы.' })
  name!: string;
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] })
  @IsIn(['teacher', 'student', 'parent'], { message: 'Выберите роль.' }) role!: Role;
  @ApiProperty({ required: false, description: 'Required for teachers. International phone number.', example: '+994501234567' })
  @ValidateIf((dto: RegisterDto) => dto.role === 'teacher' || dto.phone !== undefined)
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString({ message: phoneMessage }) @Matches(phonePattern, { message: phoneMessage })
  phone?: string;
  @ApiProperty({ required: false, description: 'Required for teachers. Calendar date, not in the future.', format: 'date', example: '1990-04-12' })
  @ValidateIf((dto: RegisterDto) => dto.role === 'teacher' || dto.birthDate !== undefined)
  @BirthDate() birthDate?: string;
  @ApiProperty({ required: false, description: 'Required for teachers. First subject, created with the account.', minLength: 1, maxLength: 100 })
  @ValidateIf((dto: RegisterDto) => dto.role === 'teacher' || dto.subject !== undefined)
  @Transform(tidy) @IsString() @Length(1, 100, { message: 'Название предмета должно содержать от 1 до 100 символов.' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Название содержит недопустимые символы.' })
  subject?: string;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Нужно принять условия использования.' }) acceptTerms!: true;
  @ApiProperty({ enum: [true] }) @Equals(true, { message: 'Нужно принять политику конфиденциальности.' }) acceptPrivacy!: true;
}
export class TokenDto {
  @ApiProperty({ minLength: 43, maxLength: 43 })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'Ссылка недействительна.' }) token!: string;
}
export class ResetDto extends TokenDto {
  @ApiProperty({ format: 'password', minLength: 10, maxLength: 128 })
  @IsString() @Length(10, 128, { message: 'Пароль должен содержать от 10 до 128 символов.' }) password!: string;
}
export class RoleDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] })
  @IsIn(['teacher', 'student', 'parent'], { message: 'Выберите роль.' }) role!: Role;
  @ApiProperty({ required: false, description: 'Required when adding the teacher role for the first time.', example: '+994501234567' })
  @ValidateIf((_dto: RoleDto, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString({ message: phoneMessage }) @Matches(phonePattern, { message: phoneMessage })
  phone?: string;
  @ApiProperty({ required: false, description: 'Required when adding the teacher role for the first time.', format: 'date' })
  @ValidateIf((_dto: RoleDto, value: unknown) => value !== undefined)
  @BirthDate() birthDate?: string;
  @ApiProperty({ required: false, description: 'Required when adding the teacher role for the first time.', minLength: 1, maxLength: 100 })
  @ValidateIf((_dto: RoleDto, value: unknown) => value !== undefined)
  @Transform(tidy) @IsString() @Length(1, 100, { message: 'Название предмета должно содержать от 1 до 100 символов.' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Название содержит недопустимые символы.' })
  subject?: string;
}
export class SubjectDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(tidy) @IsString() @Length(1, 100, { message: 'Название предмета должно содержать от 1 до 100 символов.' })
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Название содержит недопустимые символы.' })
  name!: string;
}
// Keep a decorated property-free class: validation rejects extra input on empty-body actions.
export class EmptyDto {}
