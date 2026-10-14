import { describe, expect, it } from 'vitest';

import { linkPage } from './page.ts';

describe('linkPage', () => {
  it('places the link token as JSON that cannot close the script', () => {
    const page = linkPage('link-sandbox-</script><b>');
    expect(page).toContain('token: "link-sandbox-\\u003c/script>\\u003cb>"');
    expect(page.match(/<\/script>/g)).toHaveLength(2);
  });

  it("hands Link's error back by its codes", () => {
    expect(linkPage('t')).toContain("error.error_type + '/' + error.error_code");
  });

  it('hands back where Link stopped and its session even when there is no error', () => {
    const page = linkPage('t');
    expect(page).toContain('onExit: (error, metadata)');
    expect(page).toContain('metadata.status');
    expect(page).toContain('metadata.link_session_id');
  });
});
