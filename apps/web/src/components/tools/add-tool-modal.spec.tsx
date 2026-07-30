import { render, screen, waitFor } from '@testing-library/react';
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
