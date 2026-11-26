import { Transform } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsIn, IsISO31661Alpha2, IsString, IsUUID, Length, Matches, ValidateBy, ValidateIf,
} from 'class-validator';
import { isPublicProfileText, isSingleLine } from '../contact';
import { INVALID_INVITE } from '../exchange/invites.service';
import { CONSENT_REQUIRED } from '../privacy/policy';

export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;
export const TELEGRAM_PATTERN = /^@?[A-Za-z][A-Za-z\d_]{4,31}$/;

const trimText = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const emailValue = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const countryCode = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value;
const defined = (_object: object, value: unknown) => value !== undefined;

function SingleLineText(field: 'private' | 'public' = 'private') {
  const publicField = field === 'public';
  const validate = publicField ? isPublicProfileText : isSingleLine;
  return ValidateBy({
    name: publicField ? 'isPublicProfileText' : 'isSingleLine',
    validator: { validate: (value: unknown) => typeof value === 'string' && validate(value) },
  }, {
    message: publicField
      ? 'Публичные поля должны быть в одну строку и без ссылок или контактов.'
      : 'Поле должно содержать одну строку текста.',
  });
}

export class AcceptPolicyDto {
  @Transform(trimText)
  @IsString({ message: 'Укажите версию политики обработки данных' })
  @Length(1, 32, { message: 'Укажите версию политики обработки данных' })
  pdPolicyVersion!: string;

  @ValidateIf(defined)
  @IsBoolean({ message: 'Укажите согласие на информационные письма' })
  infoEmailConsent?: boolean;
}

export class RegisterDto extends AcceptPolicyDto {
  @IsIn([true], { message: CONSENT_REQUIRED })
  pdConsent!: true;

  @ValidateIf(defined)
  @IsString({ message: INVALID_INVITE })
  @Length(4, 20, { message: INVALID_INVITE })
  inviteCode?: string;

  @IsString({ message: 'Пройдите проверку CAPTCHA.' })
  @Length(1, 2048, { message: 'Повторите проверку CAPTCHA.' })
  captchaToken!: string;

  @Transform(trimText)
  @Matches(USERNAME_PATTERN, { message: 'Логин должен содержать от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний и начинаться с буквы или цифры.' })
  username!: string;

  @Transform(emailValue)
  @IsEmail({}, { message: 'Укажите действующий адрес электронной почты.' })
  @Length(3, 254, { message: 'Адрес электронной почты слишком длинный.' })
  @SingleLineText()
  email!: string;

  @IsString({ message: 'Введите пароль.' })
  @Length(12, 128, { message: 'Пароль должен содержать от 12 до 128 символов.' })
  password!: string;

  @IsIn(['BUYER', 'SELLER'], { message: 'Выберите роль покупателя или продавца.' })
  role!: 'BUYER' | 'SELLER';

  @IsIn(['INDIVIDUAL', 'COMPANY'], { message: 'Выберите тип участника.' })
  participantType!: 'INDIVIDUAL' | 'COMPANY';

  @Transform(trimText)
  @ValidateIf((object: RegisterDto) => object.participantType === 'COMPANY' || object.companyName !== undefined)
  @IsString({ message: 'Введите название компании.' })
  @Length(2, 120, { message: 'Название компании должно содержать от 2 до 120 символов.' })
  @SingleLineText()
  companyName?: string;

  @Transform(trimText)
  @IsString({ message: 'Введите название города.' })
  @Length(2, 80, { message: 'Название города должно содержать от 2 до 80 символов.' })
  @SingleLineText('public')
  city!: string;

  @Transform(countryCode)
  @IsISO31661Alpha2({ message: 'Выберите страну.' })
  country!: string;

  @Transform(trimText)
  @Matches(TELEGRAM_PATTERN, { message: 'Введите имя пользователя Telegram (от 5 до 32 символов, начиная с латинской буквы).' })
  telegram!: string;
}

export class LoginDto {
  @Transform(trimText)
  @IsString({ message: 'Введите логин или почту.' })
  @Length(1, 254, { message: 'Проверьте длину логина или адреса электронной почты.' })
  @SingleLineText()
  login!: string;

  @IsString({ message: 'Введите пароль.' })
  @Length(1, 128, { message: 'Проверьте длину пароля.' })
  password!: string;
}

export class ChallengeDto {
  @IsUUID('4', { message: 'Запросите новый код подтверждения.' })
  challengeId!: string;
}

export class VerifyDto extends ChallengeDto {
  @Transform(trimText)
  @Matches(/^\d{6}$/, { message: 'Введите шестизначный код из письма.' })
  code!: string;
}

export class ProfileDto {
  @ValidateIf(defined)
  @IsBoolean({ message: 'Укажите согласие на информационные письма' })
  infoEmailConsent?: boolean;

  @ValidateIf(defined)
  @IsBoolean({ message: 'Выберите, хотите ли получать уведомления по почте.' })
  notifyEmail?: boolean;

  @Transform(trimText)
  @ValidateIf(defined)
  @IsString({ message: 'Введите отображаемое имя.' })
  @Length(2, 80, { message: 'Отображаемое имя должно содержать от 2 до 80 символов.' })
  @SingleLineText()
  displayName?: string;

  @Transform(trimText)
  @ValidateIf(defined)
  @IsString({ message: 'Введите название компании.' })
  @Length(2, 120, { message: 'Название компании должно содержать от 2 до 120 символов.' })
  @SingleLineText()
  companyName?: string;

  @Transform(trimText)
  @ValidateIf(defined)
  @IsString({ message: 'Введите название города.' })
  @Length(2, 80, { message: 'Название города должно содержать от 2 до 80 символов.' })
  @SingleLineText()
  city?: string;

  @Transform(countryCode)
  @ValidateIf(defined)
  @IsISO31661Alpha2({ message: 'Выберите страну.' })
  country?: string;

  @Transform(trimText)
  @ValidateIf(defined)
  @Matches(TELEGRAM_PATTERN, { message: 'Введите действующее имя пользователя Telegram.' })
  telegram?: string;
}

export class PasswordDto {
  @IsString({ message: 'Введите текущий пароль.' })
  @Length(1, 128, { message: 'Введите текущий пароль.' })
  currentPassword!: string;

  @IsString({ message: 'Введите новый пароль.' })
  @Length(12, 128, { message: 'Новый пароль должен содержать от 12 до 128 символов.' })
  newPassword!: string;
}

export class CredentialsDto extends PasswordDto {
  @Transform(trimText)
  @ValidateIf(defined)
  @Matches(USERNAME_PATTERN, { message: 'Проверьте формат логина (от 3 до 32 латинских символов).' })
  username?: string;
}

export class CreateModeratorDto {
  @Transform(trimText)
  @Matches(USERNAME_PATTERN, { message: 'Проверьте формат логина (от 3 до 32 латинских символов).' })
  username!: string;

  @Transform(trimText)
  @IsString({ message: 'Введите отображаемое имя.' })
  @Length(2, 80, { message: 'Отображаемое имя должно содержать от 2 до 80 символов.' })
  @SingleLineText('public')
  displayName!: string;

  @Transform(emailValue)
  @IsEmail({}, { message: 'Укажите действующий адрес электронной почты.' })
  @Length(3, 254, { message: 'Адрес электронной почты слишком длинный.' })
  @SingleLineText()
  email!: string;

  @IsString({ message: 'Введите временный пароль.' })
  @Length(12, 128, { message: 'Временный пароль должен содержать от 12 до 128 символов.' })
  temporaryPassword!: string;
}
