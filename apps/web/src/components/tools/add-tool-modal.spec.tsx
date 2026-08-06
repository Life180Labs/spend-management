import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddToolModal } from './add-tool-modal';

jest.mock('@/lib/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
  },
}));

import { api } from '@/lib/api';

describe('AddToolModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables the submit button and shows "Loading…" until /departments resolves (race-condition fix)', async () => {
    let resolveDepts: (v: any) => void;
    (api.get as jest.Mock).mockReturnValue(new Promise((resolve) => { resolveDepts = resolve; }));

    render(<AddToolModal onClose={jest.fn()} onCreated={jest.fn()} />);

    const submitBtn = screen.getByRole('button', { name: 'Loading…' });
    expect(submitBtn).toBeDisabled();

    resolveDepts!([{ id: 'dept1' }]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled();
    });
  });

  it('surfaces a real error instead of silently swallowing a failed /departments fetch', async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error('Network down'));

    render(<AddToolModal onClose={jest.fn()} onCreated={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Network down')).toBeInTheDocument();
    });
    // Submit stays disabled/loading since depts never loaded.
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  });

  it('picking the Namecheap preset locks the vendor field and defaults to a yearly subscription', async () => {
    (api.get as jest.Mock).mockResolvedValue([{ id: 'dept1' }]);
    const user = userEvent.setup();

    render(<AddToolModal onClose={jest.fn()} onCreated={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled());

    // The Integration select has no htmlFor/id association with its <label>, so it's
    // targeted positionally - it's always the first <select> rendered in add mode.
    const integrationSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(integrationSelect, 'NAMECHEAP');

    // Vendor becomes a locked, read-only display of "Namecheap" rather than an editable input
    // (getAllByText because the dropdown's own <option>Namecheap</option> also matches).
    expect(screen.getAllByText('Namecheap').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByPlaceholderText('e.g. OpenAI')).not.toBeInTheDocument();

    // Billing cycle defaults to Yearly for the MOSUB preset.
    expect(screen.getByDisplayValue('Yearly')).toBeInTheDocument();
  });

  it('disables an already-connected provider in the Integration dropdown (dedup by vendor existence)', async () => {
    (api.get as jest.Mock).mockResolvedValue([{ id: 'dept1' }]);

    render(
      <AddToolModal
        onClose={jest.fn()}
        onCreated={jest.fn()}
        connectedProviders={new Set(['CLAUDE'])}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled());

    const claudeOption = screen.getByRole('option', { name: /Claude \(Anthropic\) \(already connected\)/ }) as HTMLOptionElement;
    expect(claudeOption.disabled).toBe(true);

    const railwayOption = screen.getByRole('option', { name: 'Railway' }) as HTMLOptionElement;
    expect(railwayOption.disabled).toBe(false);
  });

  it('GCP: renders the multi-field connect form instead of a single API key input, Connect stays disabled until all 5 fields are filled', async () => {
    (api.get as jest.Mock).mockResolvedValue([{ id: 'dept1' }]);
    const user = userEvent.setup();

    render(<AddToolModal onClose={jest.fn()} onCreated={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled());

    const integrationSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(integrationSelect, 'GCP');

    expect(screen.getByPlaceholderText('XXXXXX-XXXXXX-XXXXXX')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-billing-project-123456')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('spend_management_dataset')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('gcp_billing_export_v1_...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Paste the full contents of the downloaded JSON key file')).toBeInTheDocument();
    // The generic single-token input other providers use must NOT also render.
    expect(screen.queryByPlaceholderText('Paste your Railway API token')).not.toBeInTheDocument();

    // GCP is hasLimits: true, so the button reads "Fetch limits" (not the generic
    // "Connect" other multiField-less providers get).
    const connectBtn = screen.getByRole('button', { name: 'Fetch limits' });
    expect(connectBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText('XXXXXX-XXXXXX-XXXXXX'), '014575-49CC35-F26E91');
    await user.type(screen.getByPlaceholderText('my-billing-project-123456'), 'direct-volt-497417-f0');
    await user.type(screen.getByPlaceholderText('spend_management_dataset'), 'spend_management_dataset');
    await user.type(screen.getByPlaceholderText('gcp_billing_export_v1_...'), 'gcp_billing_export_v1_x');
    // Still disabled with 4/5 fields filled.
    expect(connectBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Paste the full contents of the downloaded JSON key file'), { target: { value: '{"client_email":"a","private_key":"b"}' } });

    expect(connectBtn).not.toBeDisabled();
  });

  it('GCP: submits the 5-field config (not a single tokenKey) to the integration PUT endpoint', async () => {
    (api.get as jest.Mock).mockResolvedValue([{ id: 'dept1' }]);
    (api.post as jest.Mock).mockImplementation((path: string) => {
      if (path === '/tools') return Promise.resolve({ id: 'tool1' });
      if (path === '/integrations/preview-limits') return Promise.resolve(null); // no GCP Budget configured on this account - limitsOptional falls back to manual entry
      return Promise.resolve(null);
    });
    (api.put as jest.Mock).mockResolvedValue({});
    const user = userEvent.setup();
    const onCreated = jest.fn();

    render(<AddToolModal onClose={jest.fn()} onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled());

    await user.type(screen.getByPlaceholderText('e.g. ChatGPT'), 'GCP Prod');

    const integrationSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(integrationSelect, 'GCP');

    await user.type(screen.getByPlaceholderText('XXXXXX-XXXXXX-XXXXXX'), '014575-49CC35-F26E91');
    await user.type(screen.getByPlaceholderText('my-billing-project-123456'), 'direct-volt-497417-f0');
    await user.type(screen.getByPlaceholderText('spend_management_dataset'), 'spend_management_dataset');
    await user.type(screen.getByPlaceholderText('gcp_billing_export_v1_...'), 'gcp_billing_export_v1_x');
    fireEvent.change(screen.getByPlaceholderText('Paste the full contents of the downloaded JSON key file'), { target: { value: '{"client_email":"a","private_key":"b"}' } });

    await user.click(screen.getByRole('button', { name: 'Fetch limits' }));
    // No budget configured on this GCP account (preview-limits returned null) -
    // limitsOptional falls back to the manual budget-cap fields instead of blocking.
    await waitFor(() => expect(screen.getByPlaceholderText('e.g. 1000')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('e.g. 1000'), '500');
    await user.type(screen.getByPlaceholderText('admin'), 'ops');

    await user.click(screen.getByRole('button', { name: 'Add & connect' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/integrations/tool1', {
      provider: 'GCP',
      config: {
        serviceAccountJson: '{"client_email":"a","private_key":"b"}',
        gcpProjectId: 'direct-volt-497417-f0',
        datasetId: 'spend_management_dataset',
        tableName: 'gcp_billing_export_v1_x',
        billingAccountId: '014575-49CC35-F26E91',
      },
    }));
  });

  it('blocks submit with a validation error when a required field is missing', async () => {
    (api.get as jest.Mock).mockResolvedValue([{ id: 'dept1' }]);
    const user = userEvent.setup();

    render(<AddToolModal onClose={jest.fn()} onCreated={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tool' })).not.toBeDisabled());

    await user.click(screen.getByRole('button', { name: 'Add tool' }));

    expect(await screen.findByText('Tool name is required')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
