import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createWebMiddleware } from './web';
import { CONFIG, Config } from './config';
import { Database } from './database';
import { AccountsService } from './accounts';
import { AuthService } from './auth';
import { AccountController, AuthController, HealthController, SubjectsController } from './controllers';
import { ApiError, ApiRequest, ErrorFilter, SessionGuard } from './common';
import { MAIL, MailDelivery, SmtpMail } from './mail';
import { RateLimitGuard } from './rate-limit';
import { ConnectionsService } from './connections';
import { EnrollmentsController, ParentChildrenController, ParentConnectionsController } from './connections.controllers';
import { InvitationsService } from './invitations';
import { InvitationsController, TemporaryStudentsController } from './invitations.controllers';
import type { NextFunction, Response } from 'express';
import { LessonsService } from './lessons';
import { LessonsController } from './lessons.controllers';
import { TestsService } from './tests';
import { TestAssignmentsService } from './tests.assignments';
import { TestAttemptsService } from './tests.attempts';
import { TestAssignmentsController, TestAttemptsController, TestFamiliesController, TestGroupAssignmentsController, TestsController, TestVersionsController } from './tests.controllers';
import { PaymentsService } from './payments';
import { PaymentsController } from './payments.controllers';
import { OverviewService } from './overview';
import { OverviewController } from './overview.controllers';
import { NotificationsController, NotificationPreferencesController } from './notifications.controllers';
import { NotificationsService } from './notifications';
import { NotificationsWorker } from './notifications.worker';
import { NOTIFICATION_MAIL, NotificationMailDelivery, NotificationSmtpMail } from './notifications.mail';
import { AdminService } from './admin';
import { AdminController } from './admin.controllers';
import { PackagesService } from './packages';
import { PackagesController } from './packages.controllers';
import { GroupsService } from './groups';
import { GroupsController } from './groups.controllers';

export async function createApp(config: Config, mail?: MailDelivery, notificationMail?: NotificationMailDelivery) {
  const web = config.serveWeb ? await createWebMiddleware(resolve(__dirname, '../../../.local/web'), config.production) : undefined;
  @Module({
    controllers: [AuthController, AccountController, SubjectsController, HealthController, EnrollmentsController, ParentConnectionsController, ParentChildrenController, TemporaryStudentsController, InvitationsController, LessonsController, TestsController, TestFamiliesController, TestVersionsController, TestAssignmentsController, TestGroupAssignmentsController, TestAttemptsController, PaymentsController, OverviewController, NotificationsController, NotificationPreferencesController, AdminController, PackagesController, GroupsController],
    providers: [{ provide: CONFIG, useValue: config }, Database, AccountsService, AuthService, SessionGuard, ConnectionsService, InvitationsService, LessonsService, TestsService, TestAssignmentsService, TestAttemptsService, PaymentsService, OverviewService, NotificationsService, NotificationsWorker, AdminService, PackagesService, GroupsService,
      { provide: NOTIFICATION_MAIL, ...(notificationMail ? { useValue: notificationMail } : { useClass: NotificationSmtpMail }) },
      { provide: MAIL, ...(mail ? { useValue: mail } : { useClass: SmtpMail }) },
      { provide: APP_GUARD, useClass: RateLimitGuard }],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  app.setGlobalPrefix('api/v1');
  app.use((req: ApiRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID(); res.setHeader('X-Request-ID', req.requestId); res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(helmet());
  if (web) app.use(web);
  app.enableCors({ origin: config.webOrigin, credentials: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Account-ID'], exposedHeaders: ['X-Request-ID'] });
  app.use((req: ApiRequest, _res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.headers.origin !== config.webOrigin || req.headers['x-requested-with'] !== 'ERepetitor')) {
      next(new ApiError(403, 'csrf_rejected', 'Запрос отклонён. Откройте приложение с разрешённого адреса.'));
      return;
    }
    next();
  });
  const standardJson = json({ limit: '16kb' }); const testJson = json({ limit: '512kb' });
  app.use((req: ApiRequest, res: Response, next: NextFunction) => {
    const parser = /^\/api\/v1\/(tests|attempts)(?:\/|$)/i.test(req.path) ? testJson : standardJson;
    parser(req, res, next);
  });
  app.use(urlencoded({ extended: false, limit: '16kb' }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
    forbidUnknownValues: false, transformOptions: { enableImplicitConversion: false },
    exceptionFactory: errors => {
      const first = errors.flatMap(error => Object.values(error.constraints ?? {}))[0];
      return new ApiError(400, 'validation_error', first && /[А-Яа-яЁё]/.test(first) ? first : 'Проверьте формат и обязательные поля запроса.');
    },
  }));
  app.useGlobalFilters(new ErrorFilter());
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('E-Repetitor Accounts and Connections API')
    .setDescription('All mutations require Origin equal to WEB_ORIGIN and X-Requested-With: ERepetitor. Cookie credentials required. Send X-Account-ID to reject stale account contexts. Tutors request enrollment; only owning students accept enrollments and parent connections. Local development milestone.')
    .setVersion('0.1.0').addCookieAuth('er_access').build());
  SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json', ui: !config.production });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
