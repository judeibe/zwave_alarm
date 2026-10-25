import { Router } from 'express';
import { ApiError } from '../app.js';
import { callerIdentity } from '../actor.js';
import { createModeScheduleBodySchema, updateModeScheduleBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { EventRepository, RecordSecurityEventInput } from '../../events/event-repository.js';
import type { ModeSchedule, ModeScheduleInput, ModeScheduleRepository } from '../../alarm/mode-schedule.js';

export interface ModeScheduleRouteDeps {
  modeSchedules: ModeScheduleRepository;
  eventRepo: EventRepository;
}

function describe(schedule: ModeSchedule): string {
  return `"${schedule.name}" -> ${schedule.mode} at ${schedule.time} on ${schedule.days.join(',')}${schedule.enabled ? '' : ' (disabled)'}`;
}

/**
 * `GET/POST /mode-schedules`, `PATCH/DELETE /mode-schedules/{id}`: schedules that arm or disarm the panel at a
 * time of day (Ring spec, Arming). Creating, changing and deleting are owner-only (administrator). A schedule at
 * the same minute, time zone and weekday as another enabled one is rejected with 409 `schedule_conflict`.
 */
export function createModeScheduleRouter({ modeSchedules, eventRepo }: ModeScheduleRouteDeps): Router {
  const router = Router();

  const audit = (req: Parameters<typeof callerIdentity>[0], type: RecordSecurityEventInput['type'], details: string): void => {
    eventRepo.record({ type, ...callerIdentity(req), details });
  };

  const rejectConflict = (candidate: ModeSchedule): void => {
    const other = modeSchedules.findConflict(candidate);
    if (other) {
      throw new ApiError(
        409,
        'schedule_conflict',
        `"${other.name}" already runs at ${other.time} on a day this schedule uses.`,
        { conflictsWith: other.id },
      );
    }
  };

  router.get('/mode-schedules', requireAuth, requireRole('administrator', 'member', 'installer'), (_req, res) => {
    res.status(200).json(modeSchedules.list());
  });

  router.post(
    '/mode-schedules',
    requireAuth,
    requireRole('administrator'),
    validateBody(createModeScheduleBodySchema),
    (req, res) => {
      const body = req.body as Omit<ModeScheduleInput, 'enabled' | 'timeZone'> & Partial<Pick<ModeScheduleInput, 'enabled' | 'timeZone'>>;
      const input: ModeScheduleInput = { ...body, enabled: body.enabled ?? true, timeZone: body.timeZone ?? null };
      rejectConflict({ ...input, id: '', createdAt: 0, lastRunAt: null });
      const created = modeSchedules.create(input);
      audit(req, 'mode_schedule_added', `Schedule ${describe(created)} added`);
      res.status(201).json(created);
    },
  );

  router.patch(
    '/mode-schedules/:scheduleId',
    requireAuth,
    requireRole('administrator'),
    validateBody(updateModeScheduleBodySchema),
    (req, res) => {
      const current = modeSchedules.findById(req.params.scheduleId);
      if (!current) {
        throw new ApiError(404, 'not_found', `Schedule ${req.params.scheduleId} does not exist.`);
      }
      const updated: ModeSchedule = { ...current, ...(req.body as Partial<ModeScheduleInput>) };
      rejectConflict(updated);
      modeSchedules.update(updated);
      audit(req, 'mode_schedule_updated', `Schedule ${describe(updated)} changed`);
      res.status(200).json(updated);
    },
  );

  router.delete('/mode-schedules/:scheduleId', requireAuth, requireRole('administrator'), (req, res) => {
    const existing = modeSchedules.findById(req.params.scheduleId);
    if (!existing || !modeSchedules.delete(existing.id)) {
      throw new ApiError(404, 'not_found', `Schedule ${req.params.scheduleId} does not exist.`);
    }
    audit(req, 'mode_schedule_removed', `Schedule ${describe(existing)} removed`);
    res.status(204).send();
  });

  return router;
}
