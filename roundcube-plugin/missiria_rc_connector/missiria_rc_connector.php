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
 *  - HMAC-authenticated address-book lookup used by the search_contacts tool
 *
 * No credentials or tokens are ever stored by this plugin.
 *
 * @license MIT
 * @see https://github.com/missiria/MISSIRIA-RC-Connector
 */
class missiria_rc_connector extends rcube_plugin
{
    public $task = 'rcconnector|settings';

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

        $this->register_task('rcconnector');
        $this->add_hook('startup', [$this, 'on_startup']);
        $this->add_hook('login_after', [$this, 'on_login_after']);

        // consent (needs an authenticated session; Roundcube enforces the login)
        $this->register_action('consent', [$this, 'consent_action']);

        // settings section
        $this->add_hook('settings_actions', [$this, 'settings_actions']);
        $this->register_action('plugin.rc_connector', [$this, 'settings_action']);
        $this->register_action('plugin.rc_connector-create', [$this, 'create_token_action']);
        $this->register_action('plugin.rc_connector-revoke', [$this, 'revoke_action']);
    }

    // ------------------------------------------------------------------ hooks

    /**
     * Runs before authentication. Two jobs:
     *  1. the unauthenticated contacts endpoint for the MCP server (HMAC-signed, 60 s window)
     *  2. remember a consent request so the user lands back on it after logging in
     */
    public function on_startup($args)
    {
        if ($args['task'] !== 'rcconnector') {
            return $args;
        }
        if ($args['action'] === 'contacts') {
            $this->contacts_endpoint();
            exit;
        }
        if ($args['action'] === 'consent' && empty($this->rc->user->ID)) {
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
                    $grant = $this->client()->createGrant($this->mailbox_payload() + ['request_id' => $req, 'scopes' => $granted]);
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

        // active connections
        $grants = $online ? $this->client()->listGrants($user) : [];
        $rows   = '';
        foreach ($grants as $g) {
            $revoke = $this->rc->output->form_tag(['method' => 'post', 'action' => $this->rc->url(['_task' => 'settings', '_action' => 'plugin.rc_connector-revoke']), 'class' => 'inline'],
                (new html_hiddenfield(['name' => 'id', 'value' => $g['id']]))->show()
                . html::tag('button', ['type' => 'submit', 'class' => 'btn btn-sm btn-danger', 'data-confirm' => $this->gettext('revoke_confirm')], $this->gettext('revoke')));
            $rows .= html::tag('tr', null,
                html::tag('td', null, rcube::Q($g['client_name'] ?: ($g['kind'] === 'pat' ? 'CLI token' : 'OAuth client')))
                . html::tag('td', null, rcube::Q($g['kind'] === 'pat' ? 'CLI token' : 'OAuth'))
                . html::tag('td', 'rc-scopes', rcube::Q(implode(' ', $g['scopes'] ?? [])))
                . html::tag('td', null, $this->fmt_date($g['created_at'] ?? null))
                . html::tag('td', null, $this->fmt_date($g['last_used_at'] ?? null))
                . html::tag('td', null, $revoke));
        }
        $table = html::tag('table', ['class' => 'table table-sm rc-connector-grants'],
            html::tag('thead', null, html::tag('tr', null,
                html::tag('th', null, $this->gettext('col_client')) . html::tag('th', null, $this->gettext('col_type')) . html::tag('th', null, $this->gettext('col_scopes'))
                . html::tag('th', null, $this->gettext('col_created')) . html::tag('th', null, $this->gettext('col_last_used')) . html::tag('th', null, '')))
            . html::tag('tbody', null, $rows ?: html::tag('tr', null, html::tag('td', ['colspan' => 6, 'class' => 'hint'], $this->gettext('no_grants')))));
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('active_connections')) . $table);

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
            $arows .= html::tag('tr', null, html::tag('td', null, $this->fmt_date($a['created_at'] ?? null)) . html::tag('td', null, rcube::Q($a['tool'] ?? '')) . html::tag('td', null, rcube::Q($a['folder'] ?? '')) . html::tag('td', 'rc-outcome-' . rcube::Q($a['outcome'] ?? ''), rcube::Q($a['outcome'] ?? '')) . html::tag('td', null, (int) ($a['ms'] ?? 0) . ' ms'));
        }
        $atable = html::tag('table', ['class' => 'table table-sm rc-connector-audit'],
            html::tag('thead', null, html::tag('tr', null, html::tag('th', null, $this->gettext('col_when')) . html::tag('th', null, $this->gettext('col_tool')) . html::tag('th', null, $this->gettext('col_folder')) . html::tag('th', null, $this->gettext('col_outcome')) . html::tag('th', null, $this->gettext('col_duration'))))
            . html::tag('tbody', null, $arows ?: html::tag('tr', null, html::tag('td', ['colspan' => 5, 'class' => 'hint'], $this->gettext('no_audit')))));
        $html .= html::div('rc-connector-section', html::tag('h3', null, $this->gettext('recent_activity')) . html::p('hint', $this->gettext('audit_hint')) . $atable);

        return html::div(['id' => 'rc-connector', 'class' => 'rc-connector'], $html);
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

    /** GET ?_task=rcconnector&_action=contacts&user=&q=&ts=&sig=&limit= (called by the MCP server) */
    private function contacts_endpoint()
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        $user  = $this->in('user', rcube_utils::INPUT_GET);
        $q     = $this->in('q', rcube_utils::INPUT_GET);
        $ts    = $this->in('ts', rcube_utils::INPUT_GET);
        $sig   = $this->in('sig', rcube_utils::INPUT_GET);
        $limit = min(50, max(1, (int) $this->in('limit', rcube_utils::INPUT_GET) ?: 20));

        try {
            $valid = $user !== '' && $this->signature()->verifyContacts($user, $ts, $q, $sig);
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
        $res      = $db->query("SELECT `user_id` FROM $users WHERE `username` = ?", $user);
        $ids      = [];
        while ($row = $db->fetch_assoc($res)) {
            $ids[] = (int) $row['user_id'];
        }
        $out = [];
        if ($ids) {
            $like = '%' . addcslashes($q, '%_') . '%';
            $sql  = "SELECT `name`, `email` FROM $contacts WHERE `del` <> 1 AND `user_id` IN (" . implode(',', $ids) . ") AND (`name` LIKE ? OR `email` LIKE ?) ORDER BY `name` LIMIT " . ($limit * 2);
            $res  = $db->query($sql, $like, $like);
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

        $imap = rc_connector_mailhost::imap((string) ($_SESSION['storage_host'] ?? ''), $_SESSION['storage_port'] ?? null, $_SESSION['storage_ssl'] ?? null);
        $smtp = rc_connector_mailhost::smtp($this->rc->config->get('smtp_host', 'localhost'), $this->rc->config->get('smtp_port'), $imap['host']);
        $payload = [
            'username'    => $this->rc->get_user_name(),
            'imap_host'   => $imap['host'],
            'imap_port'   => $imap['port'],
            'imap_secure' => $imap['secure'],
            'smtp_host'   => $smtp['host'],
            'smtp_port'   => $smtp['port'],
            'sealed'      => $sealed,
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
