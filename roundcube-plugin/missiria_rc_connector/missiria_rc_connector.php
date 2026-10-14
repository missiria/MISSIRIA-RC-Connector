<?php

/**
 * MISSIRIA RC Connector — Roundcube plugin
 *
 * Lets MCP-capable AI assistants (ChatGPT, Claude, Gemini, Cursor, …) access this mailbox
 * through the companion MCP server, with per-grant consent and revocation from webmail.
 *
 * Responsibilities (everything that needs a Roundcube session):
 *  - consent screen for OAuth authorization requests started on the MCP server
 *  - sealing the mailbox password with the server public key (libsodium sealed box)
 *  - Settings → "AI Connectors": CLI tokens, active connections, audit view
 *  - linking further mailboxes to a connection with one-time codes (ADR-002)
 *  - HMAC-authenticated address-book lookup used by the search_contacts tool
 *
 * No credentials or tokens are ever stored by this plugin.
 *
 * @license MIT
 * @see https://github.com/missiria/MISSIRIA-RC-Connector
 */
// Roundcube autoloads only its own classes; the plugin's helpers are plain PHP files.
foreach (['rc_connector_sealer', 'rc_connector_signature', 'rc_connector_internal_client', 'rc_connector_mailhost', 'rc_connector_scopes', 'rc_connector_alias'] as $rc_connector_lib) {
    require_once __DIR__ . '/lib/' . $rc_connector_lib . '.php';
}
unset($rc_connector_lib);

class missiria_rc_connector extends rcube_plugin
{
    // 'login' is included on purpose: Roundcube rewrites the task of every anonymous request to
    // 'login', and a plugin not registered for that task never initialises, so neither the
    // contacts endpoint nor the pre-login consent stash would run.
    public $task = 'login|rcconnector|settings';

    /** @var rcmail */
    private $rc;
    /** @var rc_connector_internal_client|null */
    private $client;
    /** @var rc_connector_signature|null */
    private $sig;

    public function init()
    {
        $this->rc = rcmail::get_instance();
        $this->load_config();
        $this->add_texts('localization/', false);

        $this->add_hook('startup', [$this, 'on_startup']);
        $this->add_hook('login_after', [$this, 'on_login_after']);

        // Settings section. These MUST be registered before register_task(): once a plugin owns a
        // task, rcube_plugin::register_action() prefixes every action with that task name, which
        // would turn 'plugin.rc_connector' into 'rcconnector.plugin.rc_connector' (→ error 524).
        $this->add_hook('settings_actions', [$this, 'settings_actions']);
        $this->register_action('plugin.rc_connector', [$this, 'settings_action']);
        $this->register_action('plugin.rc_connector-create', [$this, 'create_token_action']);
        $this->register_action('plugin.rc_connector-revoke', [$this, 'revoke_action']);
        $this->register_action('plugin.rc_connector-linkcode', [$this, 'linkcode_action']);
        $this->register_action('plugin.rc_connector-join', [$this, 'join_action']);
        $this->register_action('plugin.rc_connector-unlink', [$this, 'unlink_action']);
        $this->register_action('plugin.rc_connector-allmailboxes', [$this, 'allmailboxes_action']);

        // Own task for the consent screen (dispatched as 'rcconnector.consent'; login enforced by Roundcube)
        $this->register_task('rcconnector');
        $this->register_action('consent', [$this, 'consent_action']);
    }

    // ------------------------------------------------------------------ hooks

    /**
     * Runs before authentication. Two jobs:
     *  1. the unauthenticated contacts endpoint for the MCP server (HMAC-signed, 60 s window)
     *  2. remember a consent request so the user lands back on it after logging in
     */
    public function on_startup($args)
    {
        // For anonymous visitors Roundcube already replaced the task with 'login'; look at the raw request.
        $task   = $args['task'] === 'login' ? $this->in('_task', rcube_utils::INPUT_GPC) : $args['task'];
        $action = $args['task'] === 'login' ? $this->in('_action', rcube_utils::INPUT_GPC) : $args['action'];
        if ($task !== 'rcconnector') {
            return $args;
        }
        if ($action === 'contacts') {
            $this->contacts_endpoint();
            exit;
        }
        if ($action === 'consent' && empty($this->rc->user->ID)) {
            $req = $this->in('req', rcube_utils::INPUT_GET);
            $sig = $this->in('sig', rcube_utils::INPUT_GET);
            if ($req && $sig && $this->signature()->verifyConsent($req, $sig)) {
                $_SESSION['rc_connector_pending'] = ['req' => $req, 'sig' => $sig];
            }
        }
        return $args;
    }

    public function on_login_after($args)
    {
        if (!empty($_SESSION['rc_connector_pending'])) {
            $pending = $_SESSION['rc_connector_pending'];
            $this->rc->session->remove('rc_connector_pending');
            return ['_task' => 'rcconnector', '_action' => 'consent', 'req' => $pending['req'], 'sig' => $pending['sig']];
        }
        return $args;
    }

    public function settings_actions($args)
    {
        $args['actions'][] = [
            'action' => 'plugin.rc_connector',
            'class'  => 'rcconnector',
            'label'  => 'ai_connectors',
            'title'  => 'ai_connectors_title',
            'domain' => 'missiria_rc_connector',
        ];
        return $args;
    }

    // ---------------------------------------------------------------- consent

    public function consent_action()
    {
        $req = $this->in('req', rcube_utils::INPUT_GPC);
        $sig = $this->in('sig', rcube_utils::INPUT_GPC);
        if (!$req || !$sig || !$this->signature()->verifyConsent($req, $sig)) {
            return $this->render_message('consent_invalid_link', 'error');
        }
        $this->rc->session->remove('rc_connector_pending');

        try {
            $request = $this->client()->getAuthRequest($req);
        } catch (Throwable $e) {
            rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
            return $this->render_message('server_unreachable', 'error');
        }
        if (!$request || ($request['status'] ?? '') !== 'pending') {
            return $this->render_message('consent_expired', 'error');
        }

        $allowWrite = (bool) $this->rc->config->get('rc_connector_allow_write', true);
        $offerable  = rc_connector_scopes::offerable($request['scopes'] ?? [], $allowWrite);
        if (!$offerable) {
            return $this->render_message('consent_no_scopes', 'error');
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $decision = $this->in('decision', rcube_utils::INPUT_POST);
            $public   = rtrim((string) $this->rc->config->get('rc_connector_public_url'), '/');
            if ($decision !== 'approve') {
                $this->rc->output->redirect($public . '/oauth/callback?' . http_build_query(['req' => $req, 'error' => 'access_denied']), 0, true);
                return;
            }
            $ticked  = (array) rcube_utils::get_input_value('scopes', rcube_utils::INPUT_POST);
            $granted = rc_connector_scopes::granted($ticked, $offerable);
            if (!$granted) {
                $this->rc->output->show_message($this->gettext('consent_pick_scope'), 'warning');
            } else {
                try {
                    $payload = $this->mailbox_payload() + ['request_id' => $req, 'scopes' => $granted];
                    // ADR-003: only offered to admins (server decides); the server re-checks and refuses otherwise.
                    if ($this->in('all_mailboxes', rcube_utils::INPUT_POST) === '1' && !empty($this->all_mailboxes_offer())) {
                        $payload['all_mailboxes'] = true;
                    }
                    $grant = $this->client()->createGrant($payload);
                    $this->rc->output->redirect($public . '/oauth/callback?' . http_build_query(['req' => $req, 'code' => $grant['code']]), 0, true);
                    return;
                } catch (Throwable $e) {
                    rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                    return $this->render_message('server_unreachable', 'error');
                }
            }
        }

        $this->rc->output->set_env('rc_connector_request', $req);
        $this->rc->output->set_pagetitle($this->gettext('consent_title'));
        $this->rc->output->add_handler('rcconnectorconsent', function () use ($request, $offerable, $req, $sig) {
            return $this->consent_html($request, $offerable, $req, $sig);
        });
        $this->include_stylesheet($this->local_skin_path() . '/rc_connector.css');
        $this->rc->output->send('missiria_rc_connector.consent');
    }

    private function consent_html(array $request, array $offerable, string $req, string $sig): string
    {
        $defaults = (array) $this->rc->config->get('rc_connector_default_scopes', ['mail:read']);
        $client   = rcube::Q($request['client_name'] ?? 'Unknown client');
        $host     = rcube::Q($request['redirect_host'] ?? '');
        $user     = rcube::Q($this->rc->get_user_name());

        $html  = html::div('rc-connector-client', html::tag('h3', null, $this->gettext(['name' => 'consent_heading', 'vars' => ['client' => $client]])));
        $html .= html::p('rc-connector-meta', $this->gettext(['name' => 'consent_redirect_host', 'vars' => ['host' => $host]]));
        $html .= html::p('rc-connector-meta', $this->gettext(['name' => 'consent_mailbox', 'vars' => ['user' => $user]]));
        $html .= html::p('rc-connector-warning', $this->gettext('consent_check_name'));

        $list = '';
        foreach ($offerable as $scope) {
            $id      = 'scope_' . str_replace(':', '_', $scope);
            $checked = in_array($scope, $defaults, true);
            $box     = new html_checkbox(['name' => 'scopes[]', 'value' => $scope, 'id' => $id, 'class' => 'form-check-input']);
            $label   = html::label(['for' => $id, 'class' => 'form-check-label'], html::span('rc-scope-name', rcube::Q($scope)) . ' ' . html::span('rc-scope-desc', $this->gettext('scope_' . str_replace(':', '_', $scope))));
            $list   .= html::div('form-check rc-scope' . (rc_connector_scopes::isWrite($scope) ? ' rc-scope-write' : ''), $box->show($checked ? $scope : '') . $label);
        }
        $html .= html::div('rc-connector-scopes', html::tag('h4', null, $this->gettext('consent_permissions')) . $list);

        // ADR-003: admins may extend this connection to every mailbox of the server (unchecked by default)
        if ($offer = $this->all_mailboxes_offer()) {
            $box   = new html_checkbox(['name' => 'all_mailboxes', 'value' => '1', 'id' => 'rc-all-mailboxes', 'class' => 'form-check-input']);
            $label = html::label(['for' => 'rc-all-mailboxes', 'class' => 'form-check-label'], html::span('rc-scope-name', $this->gettext(['name' => 'all_mailboxes_consent', 'vars' => ['count' => (int) $offer['count']]])) . ' ' . html::span('rc-scope-desc', $this->gettext('all_mailboxes_consent_desc')));
            $html .= html::div('rc-connector-scopes rc-connector-allmailboxes', html::div('form-check rc-scope rc-scope-write', $box->show('') . $label) . html::p('rc-connector-warning', $this->gettext('all_mailboxes_warning')));
        }

        $buttons  = html::tag('button', ['type' => 'submit', 'name' => 'decision', 'value' => 'approve', 'class' => 'btn btn-primary'], $this->gettext('approve'));
        $buttons .= ' ' . html::tag('button', ['type' => 'submit', 'name' => 'decision', 'value' => 'deny', 'class' => 'btn btn-secondary'], $this->gettext('deny'));
        $html    .= html::div('rc-connector-actions formbuttons', $buttons);

        $hidden = (new html_hiddenfield(['name' => 'req', 'value' => $req]))->show() . (new html_hiddenfield(['name' => 'sig', 'value' => $sig]))->show();
        return $this->rc->output->form_tag([
            'id'     => 'rc-connector-consent-form',
            'method' => 'post',
            'action' => $this->rc->url(['_task' => 'rcconnector', '_action' => 'consent']),
        ], $hidden . $html);
    }

    // --------------------------------------------------------------- settings

    public function settings_action()
    {
        $this->rc->output->set_pagetitle($this->gettext('ai_connectors'));
        $this->rc->output->add_handler('rcconnectorsettings', [$this, 'settings_html']);
        $this->include_stylesheet($this->local_skin_path() . '/rc_connector.css');
        $this->include_script('rc_connector.js');
        $this->rc->output->send('missiria_rc_connector.settings');
    }

    public function settings_html(): string
    {
        $user   = $this->rc->get_user_name();
        $online = $this->client()->healthz();
        $html   = html::div('rc-connector-status ' . ($online ? 'online' : 'offline'), $this->gettext($online ? 'server_connected' : 'server_unreachable'));

        if (!empty($_SESSION['rc_connector_new_token'])) {
            $token = $_SESSION['rc_connector_new_token'];
            $this->rc->session->remove('rc_connector_new_token');
            $html .= html::div('rc-connector-token boxwarning', html::p(null, $this->gettext('token_shown_once'))
                . html::tag('code', ['id' => 'rc-connector-new-token'], rcube::Q($token))
                . ' ' . html::tag('button', ['type' => 'button', 'class' => 'btn btn-sm btn-secondary', 'data-copy' => '#rc-connector-new-token'], $this->gettext('copy'))
                . html::p('hint', $this->gettext(['name' => 'token_usage_hint', 'vars' => ['url' => rcube::Q(rtrim((string) $this->rc->config->get('rc_connector_public_url'), '/') . '/mcp')]])));
        }

        if (!empty($_SESSION['rc_connector_link_code'])) {
            $code = $_SESSION['rc_connector_link_code'];
            $this->rc->session->remove('rc_connector_link_code');
            $html .= html::div('rc-connector-token boxinformation', html::p(null, $this->gettext('link_code_shown'))
                . html::tag('code', ['id' => 'rc-connector-link-code'], rcube::Q($code))
                . ' ' . html::tag('button', ['type' => 'button', 'class' => 'btn btn-sm btn-secondary', 'data-copy' => '#rc-connector-link-code'], $this->gettext('copy'))
                . html::tag('ol', 'hint rc-connector-steps',
                    html::tag('li', null, $this->gettext('link_step_1')) . html::tag('li', null, $this->gettext('link_step_2')) . html::tag('li', null, $this->gettext('link_step_3'))));
        }

        if (!empty($_SESSION['rc_connector_join']) && ($_SESSION['rc_connector_join']['user'] ?? '') === $user) {
            $html .= $this->join_confirm_html($_SESSION['rc_connector_join']);
        }

        // active connections (each with its linked mailboxes)
        $grants = $online ? $this->client()->listGrants($user) : [];
        $rows   = '';
        foreach ($grants as $g) {
            $revoke = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-revoke']), 'class' => 'inline'],
                (new html_hiddenfield(['name' => 'id', 'value' => $g['id']]))->show()
                . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-danger', 'data-confirm' => $this->gettext('revoke_confirm')], $this->gettext('revoke')));
            $addbox = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-linkcode']), 'class' => 'inline'],
                (new html_hiddenfield(['name' => 'id', 'value' => $g['id']]))->show()
                . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-secondary', 'title' => $this->gettext('add_mailbox_title')], $this->gettext('add_mailbox')));
            $all     = !empty($g['all_mailboxes']);
            $toggle  = !empty($g['all_mailboxes_available']) ? $this->all_mailboxes_toggle_html($g) : '';
            $boxes   = $all
                ? html::span('rc-account rc-account-all', html::tag('code', null, '*')) . ' ' . html::span('hint', $this->gettext(['name' => 'all_mailboxes_on', 'vars' => ['count' => (int) ($g['directory_count'] ?? 0)]])) . ' ' . $this->accounts_html((array) ($g['accounts'] ?? []))
                : $this->accounts_html((array) ($g['accounts'] ?? []));
            $rows .= html::tag('tr', $all ? 'rc-grant-all' : null,
                html::tag('td', null, rcube::Q($g['client_name'] ?: ($g['kind'] === 'pat' ? 'CLI token' : 'OAuth client')))
                . html::tag('td', null, rcube::Q($g['kind'] === 'pat' ? 'CLI token' : 'OAuth'))
                . html::tag('td', 'rc-scopes', rcube::Q(implode(' ', $g['scopes'] ?? [])))
                . html::tag('td', 'rc-accounts', $boxes)
                . html::tag('td', null, $this->fmt_date($g['last_used_at'] ?? null))
                . html::tag('td', 'rc-actions', $toggle . ($toggle ? ' ' : '') . $addbox . ' ' . $revoke));
        }
        $table = html::tag('table', ['class' => 'table table-sm rc-connector-grants'],
            html::tag('thead', null, html::tag('tr', null,
                html::tag('th', null, $this->gettext('col_client')) . html::tag('th', null, $this->gettext('col_type')) . html::tag('th', null, $this->gettext('col_scopes'))
                . html::tag('th', null, $this->gettext('col_mailboxes')) . html::tag('th', null, $this->gettext('col_last_used')) . html::tag('th', null, '')))
            . html::tag('tbody', null, $rows ?: html::tag('tr', null, html::tag('td', ['colspan' => 6, 'class' => 'hint'], $this->gettext('no_grants')))));
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('active_connections')) . html::p('hint', $this->gettext('connections_hint')) . $table);

        // connections this mailbox was linked into from another mailbox + join form
        $links = $online ? $this->client()->listLinks($user) : [];
        $lrows = '';
        foreach ($links as $l) {
            $unlink = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-unlink']), 'class' => 'inline'],
                (new html_hiddenfield(['name' => 'id', 'value' => $l['id']]))->show()
                . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-danger', 'data-confirm' => $this->gettext('unlink_confirm')], $this->gettext('unlink')));
            $lrows .= html::tag('tr', null,
                html::tag('td', null, rcube::Q($l['client_name'] ?: 'OAuth client'))
                . html::tag('td', null, rcube::Q($l['primary'] ?? ''))
                . html::tag('td', 'rc-alias', html::tag('code', null, rcube::Q($l['alias'] ?? '')))
                . html::tag('td', null, $this->fmt_date($l['last_used_at'] ?? null))
                . html::tag('td', null, $unlink));
        }
        $codeInput  = new html_inputfield(['name' => 'code', 'class' => 'form-control', 'maxlength' => 40, 'placeholder' => 'LINK-XXXX-XXXX', 'autocomplete' => 'off', 'spellcheck' => 'false']);
        $aliasInput = new html_inputfield(['name' => 'alias', 'class' => 'form-control', 'maxlength' => 32, 'pattern' => '[a-z0-9][a-z0-9_-]{0,31}']);
        $join = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-join']), 'class' => 'rc-connector-join'],
            html::p('hint', $this->gettext('join_hint'))
            . html::div('form-group', html::label(['for' => 'rc-link-code'], $this->gettext('link_code')) . $codeInput->show('', ['id' => 'rc-link-code']))
            . html::div('form-group', html::label(['for' => 'rc-alias'], $this->gettext('alias')) . $aliasInput->show(rc_connector_alias::suggest($user, $this->rc->get_user_email()), ['id' => 'rc-alias'])
                . html::p('hint', $this->gettext('alias_hint')))
            . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-primary'], $this->gettext('join_connection')));
        $ltable = $lrows ? html::tag('table', ['class' => 'table table-sm rc-connector-links'],
            html::tag('thead', null, html::tag('tr', null, html::tag('th', null, $this->gettext('col_client')) . html::tag('th', null, $this->gettext('col_primary_mailbox')) . html::tag('th', null, $this->gettext('col_alias')) . html::tag('th', null, $this->gettext('col_last_used')) . html::tag('th', null, '')))
            . html::tag('tbody', null, $lrows)) : '';
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('linked_into')) . $ltable . $join);

        // create CLI token
        $allowWrite = (bool) $this->rc->config->get('rc_connector_allow_write', true);
        $scopes     = rc_connector_scopes::offerable(rc_connector_scopes::ALL, $allowWrite);
        $boxes      = '';
        foreach ($scopes as $scope) {
            $id    = 'pat_' . str_replace(':', '_', $scope);
            $box   = new html_checkbox(['name' => 'scopes[]', 'value' => $scope, 'id' => $id, 'class' => 'form-check-input']);
            $boxes .= html::div('form-check', $box->show($scope === 'mail:read' ? $scope : '') . html::label(['for' => $id, 'class' => 'form-check-label'], rcube::Q($scope) . ' – ' . $this->gettext('scope_' . str_replace(':', '_', $scope))));
        }
        $labelInput = new html_inputfield(['name' => 'label', 'class' => 'form-control', 'maxlength' => 80, 'placeholder' => $this->gettext('token_label_placeholder')]);
        $form = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-create']), 'class' => 'rc-connector-create'],
            html::div('form-group', html::label(['for' => 'rc-label'], $this->gettext('token_label')) . $labelInput->show('', ['id' => 'rc-label']))
            . html::div('form-group', $boxes)
            . html::p('hint', $this->gettext('token_hint'))
            . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-primary'], $this->gettext('create_token')));
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('cli_tokens')) . $form);

        // audit
        $audit = $online ? $this->client()->listAudit($user, (int) $this->rc->config->get('rc_connector_audit_rows', 50)) : [];
        $arows = '';
        foreach ($audit as $a) {
            $arows .= html::tag('tr', null, html::tag('td', null, $this->fmt_date($a['created_at'] ?? null)) . html::tag('td', null, rcube::Q($a['tool'] ?? '')) . html::tag('td', 'rc-alias', rcube::Q($a['account'] ?? '')) . html::tag('td', null, rcube::Q($a['folder'] ?? '')) . html::tag('td', 'rc-outcome-' . rcube::Q($a['outcome'] ?? ''), rcube::Q($a['outcome'] ?? '')) . html::tag('td', null, (int) ($a['ms'] ?? 0) . ' ms'));
        }
        $atable = html::tag('table', ['class' => 'table table-sm rc-connector-audit'],
            html::tag('thead', null, html::tag('tr', null, html::tag('th', null, $this->gettext('col_when')) . html::tag('th', null, $this->gettext('col_tool')) . html::tag('th', null, $this->gettext('col_alias')) . html::tag('th', null, $this->gettext('col_folder')) . html::tag('th', null, $this->gettext('col_outcome')) . html::tag('th', null, $this->gettext('col_duration'))))
            . html::tag('tbody', null, $arows ?: html::tag('tr', null, html::tag('td', ['colspan' => 6, 'class' => 'hint'], $this->gettext('no_audit')))));
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('recent_activity')) . html::p('hint', $this->gettext('audit_hint')) . $atable);

        return html::div(['id' => 'rc-connector', 'class' => 'rc-connector'], $html);
    }

    /** Alias chips for one connection; linked mailboxes get an Unlink button, the primary a marker. */
    private function accounts_html(array $accounts): string
    {
        $out = '';
        foreach ($accounts as $a) {
            $chip = html::tag('code', ['title' => rcube::Q($a['email'] ?? $a['username'] ?? '')], rcube::Q($a['alias'] ?? ''));
            if (!empty($a['primary'])) {
                $out .= html::span('rc-account rc-account-primary', $chip . ' ' . html::span('hint', $this->gettext('primary_mailbox')));
                continue;
            }
            $unlink = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-unlink']), 'class' => 'inline'],
                (new html_hiddenfield(['name' => 'id', 'value' => $a['id'] ?? '']))->show()
                . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-link btn-sm rc-unlink', 'data-confirm' => $this->gettext('unlink_confirm'), 'title' => $this->gettext('unlink')], '×'));
            $out .= html::span('rc-account', $chip . $unlink);
        }
        return $out ?: html::span('hint', '—');
    }

    /** ADR-003: the "all mailboxes" switch for one connection (admins only; the server decides who is one). */
    private function all_mailboxes_toggle_html(array $g): string
    {
        $on    = !empty($g['all_mailboxes']);
        $count = (int) ($g['directory_count'] ?? 0);
        $btn   = $on
            ? html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-secondary', 'title' => $this->gettext('all_mailboxes_disable_title')], $this->gettext('all_mailboxes_disable'))
            : html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-warning', 'data-confirm' => $this->gettext(['name' => 'all_mailboxes_confirm', 'vars' => ['count' => $count]]), 'title' => $this->gettext('all_mailboxes_enable_title')], $this->gettext(['name' => 'all_mailboxes_enable', 'vars' => ['count' => $count]]));
        return $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-allmailboxes']), 'class' => 'inline'],
            (new html_hiddenfield(['name' => 'id', 'value' => $g['id']]))->show()
            . (new html_hiddenfield(['name' => 'enabled', 'value' => $on ? '0' : '1']))->show()
            . $btn);
    }

    /** ADR-003: server facts for the consent checkbox; empty unless this user may enable server-wide reach. */
    private function all_mailboxes_offer(): array
    {
        try {
            $info = $this->client()->allMailboxesInfo($this->rc->get_user_name());
        } catch (Throwable $e) {
            return [];
        }
        return !empty($info['available']) ? ['count' => (int) ($info['count'] ?? 0)] : [];
    }

    public function allmailboxes_action()
    {
        $id      = $this->in('id', rcube_utils::INPUT_POST);
        $enabled = $this->in('enabled', rcube_utils::INPUT_POST) === '1';
        if ($id && preg_match('/^[0-9a-f]{32}$/', $id)) {
            try {
                $res = $this->client()->setAllMailboxes($id, $this->rc->get_user_name(), $enabled);
                $this->rc->output->show_message($this->gettext(['name' => $enabled ? 'all_mailboxes_enabled' : 'all_mailboxes_disabled', 'vars' => ['count' => (int) ($res['directory_count'] ?? 0)]]), 'confirmation');
            } catch (rc_connector_link_exception $e) {
                $map = ['not_admin' => 'all_mailboxes_not_admin', 'not_configured' => 'all_mailboxes_not_configured'];
                $this->rc->output->show_message($this->gettext($map[$e->getMessage()] ?? 'all_mailboxes_failed'), 'error');
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                $this->rc->output->show_message($this->gettext('server_unreachable'), 'error');
            }
        }
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    /** Step 1 of linking: the grant owner asks for a one-time code to type on the other mailbox. */
    public function linkcode_action()
    {
        $id = $this->in('id', rcube_utils::INPUT_POST);
        if ($id && preg_match('/^[0-9a-f]{32}$/', $id)) {
            try {
                $res = $this->client()->createLinkCode($id, $this->rc->get_user_name());
                $_SESSION['rc_connector_link_code'] = $res['code'];
                $this->rc->output->show_message($this->gettext('link_code_created'), 'confirmation');
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                $this->rc->output->show_message($this->gettext(strpos($e->getMessage(), 'too_many_codes') !== false ? 'link_too_many' : 'server_unreachable'), 'error');
            }
        }
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    /**
     * Step 2 of linking, in two POSTs: the first previews the connection the code belongs to
     * (client, kind, scopes, main mailbox) and parks code + alias in the session; the second
     * ("confirm") redeems from the session copy, so what the user approved is what gets linked.
     */
    public function join_action()
    {
        $user = $this->rc->get_user_name();
        if ($this->in('cancel', rcube_utils::INPUT_POST) !== '') {
            $this->rc->session->remove('rc_connector_join');
            $this->rc->output->show_message($this->gettext('join_cancelled'), 'notice');
            return $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
        }

        if ($this->in('confirm', rcube_utils::INPUT_POST) !== '') {
            $pending = $_SESSION['rc_connector_join'] ?? null;
            $this->rc->session->remove('rc_connector_join');
            if (!is_array($pending) || ($pending['user'] ?? '') !== $user) {
                $this->rc->output->show_message($this->gettext('link_code_invalid'), 'error');
                return $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
            }
            try {
                $res = $this->client()->redeemLinkCode($this->mailbox_payload() + ['code' => $pending['code'], 'alias' => $pending['alias']]);
                $this->rc->output->show_message($this->gettext(['name' => 'linked_ok', 'vars' => ['client' => $res['client_name'] ?? '', 'alias' => $res['alias'] ?? $pending['alias']]]), 'confirmation');
            } catch (rc_connector_link_exception $e) {
                $this->rc->output->show_message($this->gettext($this->link_error_label($e->getMessage())), 'error');
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                $this->rc->output->show_message($this->gettext('server_unreachable'), 'error');
            }
            return $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
        }

        // first POST: validate, preview, ask for confirmation
        $code  = trim($this->in('code', rcube_utils::INPUT_POST));
        $alias = rc_connector_alias::normalize($this->in('alias', rcube_utils::INPUT_POST));
        if ($code === '' || strlen($code) > 40) {
            $this->rc->output->show_message($this->gettext('link_code_invalid'), 'error');
        } elseif ($alias === '') {
            $this->rc->output->show_message($this->gettext('alias_invalid'), 'error');
        } else {
            try {
                $preview = $this->client()->previewLinkCode($code);
                if (!$preview) {
                    $this->rc->output->show_message($this->gettext('link_code_invalid'), 'error');
                } else {
                    $_SESSION['rc_connector_join'] = ['user' => $user, 'code' => $code, 'alias' => $alias, 'preview' => $preview];
                }
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                $this->rc->output->show_message($this->gettext('server_unreachable'), 'error');
            }
        }
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    private function link_error_label(string $code): string
    {
        $map = ['code_invalid' => 'link_code_invalid', 'code_used' => 'link_code_used', 'code_expired' => 'link_code_expired', 'already_linked' => 'already_linked', 'alias_taken' => 'alias_taken', 'invalid_alias' => 'alias_invalid'];
        return $map[$code] ?? 'link_failed';
    }

    /** Confirmation box for a pending join: who gets access to this mailbox, with which permissions. */
    private function join_confirm_html(array $pending): string
    {
        $p      = (array) ($pending['preview'] ?? []);
        $client = rcube::Q($p['client_name'] ?: ($p['kind'] === 'pat' ? 'CLI token' : 'OAuth client'));
        $list   = '';
        foreach ((array) ($p['scopes'] ?? []) as $scope) {
            if (in_array($scope, rc_connector_scopes::ALL, true)) {
                $list .= html::tag('li', rc_connector_scopes::isWrite($scope) ? 'rc-scope-write' : null, html::span('rc-scope-name', rcube::Q($scope)) . ' ' . html::span('rc-scope-desc', $this->gettext('scope_' . str_replace(':', '_', $scope))));
            }
        }
        $body  = html::tag('h4', null, $this->gettext('join_confirm_title'));
        $body .= html::p(null, $this->gettext(['name' => 'join_confirm_text', 'vars' => ['user' => rcube::Q($this->rc->get_user_name()), 'client' => $client, 'primary' => rcube::Q($p['primary'] ?? ''), 'alias' => rcube::Q($pending['alias'] ?? '')]]));
        $body .= html::tag('ul', 'rc-connector-scopelist', $list);
        $body .= html::p('rc-connector-warning', $this->gettext('join_confirm_warning'));
        $buttons = html::tag('button', ['type' => 'submit', 'name' => 'confirm', 'value' => '1', 'class' => 'btn btn-primary'], $this->gettext('join_confirm'))
            . ' ' . html::tag('button', ['type' => 'submit', 'name' => 'cancel', 'value' => '1', 'class' => 'btn btn-secondary'], $this->gettext('cancel'));
        return html::div('rc-connector-token boxwarning rc-connector-join-confirm', $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-join'])], $body . html::div('formbuttons', $buttons)));
    }

    /** Removes a linked mailbox; the server allows it to the mailbox itself and to the connection owner. */
    public function unlink_action()
    {
        $id = $this->in('id', rcube_utils::INPUT_POST);
        $ok = false;
        if ($id && preg_match('/^[0-9a-f]{32}$/', $id)) {
            try {
                $ok = $this->client()->unlinkAccount($id, $this->rc->get_user_name());
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
            }
        }
        $this->rc->output->show_message($this->gettext($ok ? 'unlinked' : 'unlink_failed'), $ok ? 'confirmation' : 'error');
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    public function create_token_action()
    {
        $label  = trim($this->in('label', rcube_utils::INPUT_POST)) ?: 'CLI token';
        $ticked = (array) rcube_utils::get_input_value('scopes', rcube_utils::INPUT_POST);
        $allow  = (bool) $this->rc->config->get('rc_connector_allow_write', true);
        $scopes = rc_connector_scopes::granted($ticked, rc_connector_scopes::offerable(rc_connector_scopes::ALL, $allow));
        if (!$scopes) {
            $this->rc->output->show_message($this->gettext('consent_pick_scope'), 'warning');
        } else {
            try {
                $pat = $this->client()->createPat($this->mailbox_payload() + ['label' => mb_substr($label, 0, 80), 'scopes' => $scopes]);
                $_SESSION['rc_connector_new_token'] = $pat['token'];
                $this->rc->output->show_message($this->gettext('token_created'), 'confirmation');
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
                $this->rc->output->show_message($this->gettext('server_unreachable'), 'error');
            }
        }
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    public function revoke_action()
    {
        $id = $this->in('id', rcube_utils::INPUT_POST);
        $ok = false;
        if ($id && preg_match('/^[0-9a-f]{32}$/', $id)) {
            try {
                $ok = $this->client()->revokeGrant($id, $this->rc->get_user_name());
            } catch (Throwable $e) {
                rcube::raise_error(['code' => 500, 'message' => 'rc_connector: ' . $e->getMessage()], true, false);
            }
        }
        $this->rc->output->show_message($this->gettext($ok ? 'revoked' : 'revoke_failed'), $ok ? 'confirmation' : 'error');
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'plugin.rc_connector']);
    }

    // ---------------------------------------------------------- contacts API

    /** GET ?_task=rcconnector&_action=contacts&user=&host=&q=&ts=&sig=&limit= (called by the MCP server) */
    private function contacts_endpoint()
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        $user  = $this->in('user', rcube_utils::INPUT_GET);
        $host  = $this->in('host', rcube_utils::INPUT_GET);
        $q     = $this->in('q', rcube_utils::INPUT_GET);
        $ts    = $this->in('ts', rcube_utils::INPUT_GET);
        $sig   = $this->in('sig', rcube_utils::INPUT_GET);
        $limit = min(50, max(1, (int) $this->in('limit', rcube_utils::INPUT_GET) ?: 20));

        try {
            $valid = $user !== '' && $host !== '' && $this->signature()->verifyContacts($user, $host, $ts, $q, $sig);
        } catch (Throwable $e) {
            $valid = false;
        }
        if (!$valid) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden']);
            return;
        }

        $db       = $this->rc->get_dbh();
        $users    = $db->table_name('users', true);
        $contacts = $db->table_name('contacts', true);
        // One mailbox = one Roundcube user row (username + mail_host). Anything else is refused.
        $res      = $db->query("SELECT `user_id` FROM $users WHERE `username` = ? AND `mail_host` = ?", $user, $host);
        $ids      = [];
        while ($row = $db->fetch_assoc($res)) {
            $ids[] = (int) $row['user_id'];
        }
        if (count($ids) !== 1) {
            http_response_code(count($ids) ? 409 : 404);
            echo json_encode(['error' => count($ids) ? 'ambiguous_user' : 'unknown_user', 'contacts' => []]);
            return;
        }
        $out = [];
        if ($ids) {
            $like = '%' . addcslashes($q, '%_') . '%';
            $sql  = "SELECT `name`, `email` FROM $contacts WHERE `del` <> 1 AND `user_id` = ? AND (`name` LIKE ? OR `email` LIKE ?) ORDER BY `name` LIMIT " . ($limit * 2);
            $res  = $db->query($sql, $ids[0], $like, $like);
            while (($row = $db->fetch_assoc($res)) && count($out) < $limit) {
                foreach (preg_split('/[,\s]+/', (string) $row['email'], -1, PREG_SPLIT_NO_EMPTY) as $email) {
                    if (count($out) >= $limit) {
                        break;
                    }
                    $out[] = ['name' => (string) $row['name'], 'email' => $email];
                }
            }
        }
        echo json_encode(['contacts' => $out], JSON_UNESCAPED_UNICODE);
    }

    // ---------------------------------------------------------------- helpers

    /** Mailbox facts + sealed password for the internal API. Plaintext is wiped by the sealer. */
    private function mailbox_payload(): array
    {
        $password = $this->rc->decrypt($_SESSION['password']);
        $sealer   = new rc_connector_sealer((string) $this->rc->config->get('rc_connector_server_pubkey'));
        $sealed   = $sealer->seal($password);
        unset($password);

        $rawHost = (string) ($_SESSION['storage_host'] ?? '');
        $imap    = rc_connector_mailhost::imap($rawHost, $_SESSION['storage_port'] ?? null, $_SESSION['storage_ssl'] ?? null);
        $smtp    = rc_connector_mailhost::smtp($this->rc->config->get('smtp_host', 'localhost'), $this->rc->config->get('smtp_port'), $imap['host'], $rawHost);
        $payload = [
            'username'  => $this->rc->get_user_name(),
            'imap_host' => $imap['host'],
            'imap_port' => $imap['port'],
            'imap_tls'  => $imap['tls'],
            'smtp_host' => $smtp['host'],
            'smtp_port' => $smtp['port'],
            'smtp_tls'  => $smtp['tls'],
            'sealed'    => $sealed,
        ];
        $email = $this->rc->get_user_email();
        if ($email && strpos($email, '@') !== false) {
            $payload['email'] = $email;
        }
        return $payload;
    }

    private function client(): rc_connector_internal_client
    {
        if (!$this->client) {
            $this->client = new rc_connector_internal_client(
                (string) $this->rc->config->get('rc_connector_internal_url', 'http://127.0.0.1:8787'),
                (string) $this->rc->config->get('rc_connector_internal_key', ''),
                (int) $this->rc->config->get('rc_connector_timeout', 3)
            );
        }
        return $this->client;
    }

    private function signature(): rc_connector_signature
    {
        if (!$this->sig) {
            $this->sig = new rc_connector_signature((string) $this->rc->config->get('rc_connector_internal_key', ''));
        }
        return $this->sig;
    }

    /** Roundcube 1.5/1.6 compatible string input (arrays and nulls become ''). */
    private function in(string $name, int $source): string
    {
        $v = rcube_utils::get_input_value($name, $source);
        return is_string($v) ? $v : '';
    }

    private function fmt_date($ts): string
    {
        return $ts ? rcube::Q($this->rc->format_date((int) $ts)) : html::span('hint', '—');
    }

    private function render_message(string $label, string $type)
    {
        $this->rc->output->set_pagetitle($this->gettext('consent_title'));
        $this->rc->output->add_handler('rcconnectorconsent', function () use ($label, $type) {
            return html::div('rc-connector-message box' . $type, rcube::Q($this->gettext($label)));
        });
        $this->include_stylesheet($this->local_skin_path() . '/rc_connector.css');
        $this->rc->output->send('missiria_rc_connector.consent');
    }
}
