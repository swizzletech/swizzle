// The scope of a token about to be minted: the highest role it may act with, and the projects and
// environments it is limited to. Settings › Agent access uses it for a person's token, a project's
// Service accounts tab for an account's token, which has no project choice and no admin.

import type { ProjectRef, ProjectRole, ScopeInput } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";

export interface Scope {
  readonly role: ProjectRole;
  /** Project slugs; empty limits nothing. */
  readonly projects: ReadonlySet<string>;
  /** Empty limits nothing. */
  readonly environments: ReadonlySet<string>;
}

/** The scope as the token routes take it; an empty choice is left out, so it limits nothing. */
export function scopeInput(scope: Scope): ScopeInput {
  return {
    role: scope.role,
    ...(scope.projects.size === 0 ? {} : { projects: [...scope.projects] }),
    ...(scope.environments.size === 0 ? {} : { environments: [...scope.environments] }),
  };
}

export function ScopeFields(props: {
  readonly value: Scope;
  readonly onChange: (scope: Scope) => void;
  readonly roles: readonly ProjectRole[];
  /** The projects to choose from; without them the scope has no project choice. */
  readonly projects?: readonly ProjectRef[];
}) {
  const { environments } = useDashboardClient();
  const { value, onChange } = props;
  const toggled = (set: ReadonlySet<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };
  return (
    <div className="grid gap-3" data-testid="scope-fields">
      <label className="form-label justify-self-start">
        At most
        <select
          className="field"
          onChange={(event) => onChange({ ...value, role: event.target.value as ProjectRole })}
          value={value.role}
        >
          {props.roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      {props.projects === undefined ? null : (
        <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0">
          <legend className="form-label mb-1">
            Only in the projects (none checked: every one)
          </legend>
          {props.projects.map((project) => (
            <label className="flex items-center gap-1.5" key={project.id}>
              <input
                checked={value.projects.has(project.slug)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    projects: toggled(value.projects, project.slug, event.target.checked),
                  })
                }
                type="checkbox"
              />
              {project.name}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0">
        <legend className="form-label mb-1">Only in (none checked: every environment)</legend>
        {environments.map((environment) => (
          <label className="flex items-center gap-1.5" key={environment}>
            <input
              checked={value.environments.has(environment)}
              onChange={(event) =>
                onChange({
                  ...value,
                  environments: toggled(value.environments, environment, event.target.checked),
                })
              }
              type="checkbox"
            />
            {environment}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
