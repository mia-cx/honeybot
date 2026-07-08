import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '../src/domain/defaults.js';
import { honeypotWarningModal, honeypotWarningPublicMessage, settingsReply } from '../src/interactions/settingsUi.js';

type Raw = { type?: number; custom_id?: string; components?: Raw[]; [key: string]: unknown };

describe('settings UI', () => {
  it('starts with only the top-level category dropdown', () => {
    const ids = customIds(settingsReply(defaultGuildConfig()).components as Raw[]);

    expect(ids).toEqual(['settings:page']);
  });

  it('shows the current category and subcategory in string selects', () => {
    const config = defaultGuildConfig();

    expect(selectedOptionValues(select(config, 'triggers_honeypots', 'settings:page'))).toEqual(['triggers']);
    expect(selectedOptionValues(select(config, 'triggers_honeypots', 'settings:subcategory:triggers'))).toEqual(['triggers_honeypots']);
    expect(selectedOptionValues(select(config, 'policies_punishment', 'settings:page'))).toEqual(['policies']);
    expect(selectedOptionValues(select(config, 'policies_punishment', 'settings:subcategory:policies'))).toEqual(['policies_punishment']);
  });

  it('pre-fills existing entity select values', () => {
    const config = {
      ...defaultGuildConfig(),
      honeypotChannelIds: ['111', '222'],
      moderatorUsers: ['333'],
      moderatorRoles: ['444'],
      moderationChannelId: '555',
      policies: {
        ...defaultGuildConfig().policies,
        punishment: { ...defaultGuildConfig().policies.punishment, actionType: 'role' as const, roleId: '666' },
      },
    };

    expect(select(config, 'triggers_honeypots', 'settings:channels:honeypots:triggers_honeypots').default_values).toEqual([
      { id: '111', type: 'channel' },
      { id: '222', type: 'channel' },
    ]);
    expect(select(config, 'permissions', 'settings:mentionables:moderators:permissions').default_values).toEqual([
      { id: '333', type: 'user' },
      { id: '444', type: 'role' },
    ]);
    expect(select(config, 'config', 'settings:channel:moderationChannelId:config').default_values).toEqual([{ id: '555', type: 'channel' }]);
    expect(select(config, 'policies_punishment', 'settings:policyRole:punishment').default_values).toEqual([{ id: '666', type: 'role' }]);
  });

  it('exposes controls for all settings categories', () => {
    const config = defaultGuildConfig();

    const triggerComponents = settingsReply(config, 'triggers').components as Raw[];
    const triggerHoneypotComponents = settingsReply(config, 'triggers_honeypots').components as Raw[];

    expect(triggerComponents).toHaveLength(2);
    expect(triggerHoneypotComponents).toHaveLength(3);
    expect(customIds(triggerHoneypotComponents[1]?.components ?? [])).toEqual(['settings:subcategory:triggers']);
    expect(customIds(triggerHoneypotComponents[2]?.components ?? [])).toEqual(expect.arrayContaining(['settings:channels:honeypots:triggers_honeypots']));

    expect(customIds(triggerHoneypotComponents)).toEqual(
      expect.arrayContaining(['settings:subcategory:triggers', 'settings:channels:honeypots:triggers_honeypots', 'settings:honeypotWarning:open:triggers_honeypots']),
    );

    const crosschannelIds = customIds(settingsReply(config, 'triggers_crosschannel').components as Raw[]);
    expect(crosschannelIds).toEqual(
      expect.arrayContaining([
        'settings:subcategory:triggers',
        'settings:toggle:crosschannelEnabled:triggers_crosschannel',
        'settings:edit:crosschannelWindowSeconds:triggers_crosschannel',
        'settings:edit:crosschannelChannelThreshold:triggers_crosschannel',
      ]),
    );
    expect(crosschannelIds).not.toEqual(expect.arrayContaining(['settings:edit:crosschannelMaxEntriesPerGuild:triggers_crosschannel', 'settings:edit:crosschannelMaxEntriesPerUser:triggers_crosschannel']));
    expect(crosschannelIds.filter((id) => id.startsWith('settings:edit:crosschannel'))).toEqual([
      'settings:edit:crosschannelChannelThreshold:triggers_crosschannel',
      'settings:edit:crosschannelWindowSeconds:triggers_crosschannel',
    ]);

    expect(customIds(settingsReply(config, 'permissions').components as Raw[])).toEqual(expect.arrayContaining(['settings:mentionables:moderators:permissions']));

    expect(customIds(settingsReply(config, 'config').components as Raw[])).toEqual(
      expect.arrayContaining([
        'settings:channel:moderationChannelId:config',
        'settings:toggle:reviewBypassEnabled:config',
        'settings:toggle:punishmentDmNotify:config',
        'settings:edit:evidenceConfidenceThreshold:config',
      ]),
    );

    expect(customIds(settingsReply(config, 'config').components as Raw[]).filter((id) => id.includes(':clear:'))).toEqual([]);
    expect(customIds(settingsReply(config, 'triggers_honeypots').components as Raw[]).filter((id) => id.includes(':clear:'))).toEqual([]);
    expect(customIds(settingsReply(config, 'permissions').components as Raw[]).filter((id) => id.includes(':clear:'))).toEqual([]);

    const preventionIds = customIds(settingsReply(config, 'policies_prevention').components as Raw[]);
    expect(preventionIds).toEqual(
      expect.arrayContaining([
        'settings:subcategory:policies',
        'settings:policyAction:honeypot_prevention',
        'settings:policyDuration:honeypot_prevention',
        'settings:policyDelete:honeypot_prevention',
        'settings:policyAction:crosschannel_prevention',
        'settings:policyDuration:crosschannel_prevention',
        'settings:policyDelete:crosschannel_prevention',
      ]),
    );
    expect(preventionIds).not.toContain('settings:policyScope');
    expect(preventionIds).not.toContain('settings:policyRole:honeypot_prevention');
    expect(preventionIds).not.toContain('settings:policyRole:crosschannel_prevention');

    const punishmentIds = customIds(settingsReply(config, 'policies_punishment').components as Raw[]);
    expect(punishmentIds).toEqual(expect.arrayContaining(['settings:subcategory:policies', 'settings:policyAction:punishment', 'settings:policyDelete:punishment']));
    expect(punishmentIds).not.toContain('settings:policyRole:punishment');
    expect(punishmentIds).not.toContain('settings:policyDuration:punishment');
  });

  it('builds the honeypot warning chooser as a modal with actual configured channel options', () => {
    const modal = honeypotWarningModal([
      { id: '111', name: 'trap' },
      { id: '222', name: 'second-trap' },
    ]);

    expect(modal?.toJSON()).toMatchObject({
      custom_id: 'settings:honeypotWarningModal',
      title: 'Send honeypot warning',
      components: [
        {
          type: 18,
          label: 'Honeypot channel',
          component: {
            type: 3,
            custom_id: 'settings:honeypotWarningChannel',
            options: [
              { label: '#trap', value: '111' },
              { label: '#second-trap', value: '222' },
            ],
          },
        },
      ],
    });
  });

  it('renders the public honeypot warning as Components V2 without exposing full policy details', () => {
    const message = honeypotWarningPublicMessage(defaultGuildConfig()) as { flags?: number; content?: string; components?: Raw[] };
    const textContent = flatten(message.components ?? [])
      .map((component) => component.content)
      .filter((content): content is string => typeof content === 'string')
      .join('\n');

    expect(message.content).toBeUndefined();
    expect(message.flags).toBe(1 << 15);
    expect(message.components?.[0]?.type).toBe(17);
    expect(textContent).toContain('This channel is now watched by Honeybot as a honeypot.');
    expect(textContent).toContain('Normal users who post here will be **timed out** immediately, and may receive further punitive action automatically.');
    expect(textContent).toContain('Honeybot uses evidence checks and classifiers, but classifiers are not infallible.');
    expect(textContent).not.toMatch(/unless a moderator|support channel|honeypot prevention policy/i);
    expect(textContent).not.toContain('timeout 6h');
  });

  it('only shows policy role and duration controls when the action needs them', () => {
    const config = {
      ...defaultGuildConfig(),
      policies: {
        ...defaultGuildConfig().policies,
        honeypot_prevention: { ...defaultGuildConfig().policies.honeypot_prevention, actionType: 'log' as const },
        crosschannel_prevention: { ...defaultGuildConfig().policies.crosschannel_prevention, actionType: 'role' as const },
        punishment: { ...defaultGuildConfig().policies.punishment, actionType: 'timeout' as const },
      },
    };

    const preventionIds = customIds(settingsReply(config, 'policies_prevention').components as Raw[]);
    expect(preventionIds).not.toContain('settings:policyRole:honeypot_prevention');
    expect(preventionIds).not.toContain('settings:policyDuration:honeypot_prevention');
    expect(preventionIds).toEqual(expect.arrayContaining(['settings:policyRole:crosschannel_prevention', 'settings:policyDuration:crosschannel_prevention']));

    const punishmentIds = customIds(settingsReply(config, 'policies_punishment').components as Raw[]);
    expect(punishmentIds).toContain('settings:policyDuration:punishment');
    expect(punishmentIds).not.toContain('settings:policyRole:punishment');
  });
});

function select(config: ReturnType<typeof defaultGuildConfig>, page: Parameters<typeof settingsReply>[1], customId: string): Raw {
  const found = flatten(settingsReply(config, page).components as Raw[]).find((component) => component.custom_id === customId);
  if (!found) throw new Error(`Missing component ${customId}`);
  return found;
}

function selectedOptionValues(component: Raw): string[] {
  const options = Array.isArray(component.options) ? (component.options as Raw[]) : [];
  return options.filter((option) => option.default === true).map((option) => String(option.value));
}

function customIds(components: Raw[]): string[] {
  return flatten(components)
    .map((component) => component.custom_id)
    .filter((id): id is string => typeof id === 'string');
}

function flatten(components: Raw[]): Raw[] {
  const result: Raw[] = [];
  const visit = (component: Raw) => {
    result.push(component);
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return result;
}
