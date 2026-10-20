// WireGuard fixtures (decision 184). Scanner-safe stand-ins with the shape of a key (32 bytes of base64).
export const fixtureKey = (tag: string) => (tag + 'FIXTURE'.repeat(10)).slice(0, 42) + 'A=';

export const PROVIDER_CONF = `# Provider export, server se-sto-wg-001
[Interface]
PrivateKey = ${fixtureKey('wgPRIVATE')}
Address = 10.66.12.34/32, fc00:bbbb:bbbb:bb01::3:c21/128
DNS = 10.64.0.1

[Peer]
PublicKey = ${fixtureKey('wgSERVER')}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 185.65.134.82:51820
`;
