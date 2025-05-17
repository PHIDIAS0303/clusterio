# Managing a Cluster

Clusterio clusters are managed through the controller by using the `clusterioctl` command line interface which is invoked by running `npx clusterioctl <command>` in the clusterio directory.
This document uses the shorthand `ctl> foo` to indicate `npx clusterioctl foo` should be executed.
Mandatory parameters are shown in `<angles bracket>` and optional pameters are in `[square brackets]`.

Before `clusterioctl` can be used it needs to be configured for the cluster it will connect to.
The easiest way to do this is to run `npx clusteriocontroller bootstrap create-ctl-config <username>` on the controller, which creates the necessary `config-control.json` for managing the cluster as the given user.


## Hosts

### List hosts

    ctl> host list

Lists all hosts.

### Generate token

    ctl> host generate-token [--id <host id>]

Generate a token for a host. `--id` is the host id.

### Create config

    ctl> host create-config [--id <host id>] [--name <host name>] [--generate-token <bool>] [--output <path to output>]

Create a host config. `--id` id the host id. `--name` is the host name. `--generate-token` decides whether to also generate a token, defaulting to `0`. `--output` is the filename for the output of the config; Default is "config-host.json", "-" for stdout.

### Update Clusterio

    ctl> host update [--id <host id>] [--name <host name>] [--restart]

If remote updates are enabled on the host, this will attempt to update `@clusterio/host` on the machine. Changes will not be applied until the host is restarted. If the `--restart` flag is provided, the host will automatically restart once the update is complete.

Remote updates are enabled by default but can be disabled on a per-machine basis at the owner's discretion. For security reasons, this configuration setting cannot be changed remotely. To modify it, run the following command locally while the host is offline:

    host> config set host.allow_remote_updates true/false

The controller also supports remote updates, following the same logic. The corresponding commands are:

    ctl> controller update [--restart]
    controller> config set controller.allow_remote_updates true/false

## Instances

### List Instances

    ctl> instance list

List instances.

### Create instance

    ctl> instance create <name> [--id <instance id>]

Create a new instance. `name` is the instance name. `--id` is the optional id.

### Kill instance

    ctl> instance kill <name>

Terminates the running Factorio server without giving it a chance to save or cleanup after itself.

Note: This may cause loss of data.

### Extract players from instance

    ctl> instance extract-players <name>

Creates a user account in the cluster for each player that has been online on the currently running save of the instance and sets the online time of that account on this instance to the online time recorded in the save.

Useful when importing a save to a cluster.
Note that the online time in a save is recorded differntly from how Clusterio records online time.
Most notably Clusterio records wall clock time while the save time is recorded in ticks and this extraction of player time assumes the game runs at 60 ticks a second.


### Config management

#### List Configuration

    ctl> instance config list <instance>

List config values for an instance. `instance` is the instance whose config values to list.

#### Set config value

    ctl> instance config set <instance> <field> [value] [--stdin]

Set field in instance config. `instance` is instance to set. `field` is field to set. `value` is value to set in field. `--stdin` signals to read value from stdin.

#### Set config property of field

To be written.

#### Edit instance config

    ctl> instance config edit <instance> [editor]

Edit instance config in a text editor. Once file is saved and editor has been exited, config values will be read back in. `instance` is the instance to edit, `editor` is the editor to use. If `editor` is not given, clusterioctl will read from the `EDITOR` or `VISUAL` enviroment variables.

### Assign instance to host

    ctl> instace assign <instance> [host]

Assigns instance to host. `instance` is instance to assign, `host` is host to assign to. If `host` is not provided, instance will be unassigned.

## Users

Clusterio automatically creates user accounts for all players that join an instance when save patching is enabled.
These accounts are used to store per player data shared between instances, like if the player should be whitelisted, admin or banned.

### List users

    ctl> user list

Lists all user accounts in the cluster along with some data for each.


### Create User

    ctl> user create <name>

Creates a new empty user account for the given Factorio player.
Note that case matters here.
This is usually not required as user accounts are created automatically for players that join instances with save patching enabled.


### Promote User to Server Admin

    ctl> user set-admin <name> [--revoke] [--create]

Promotes the user given to in-game admin on instances with the `sync_adminlist` option enabled.
If the `--revoke` switch is used the user is removed from the adminlist.

Since admin status is a part of the account data the account must exist for this to succeed, passing `--create` will create the account if it does not exist.

**Note:** Being a server admin does not grant any access to manage the cluster.
See [set-roles](#set-cluster-roles) for adding roles which grant access to managing the clusetr.


### Whitelist User

    ctl> user set-whitelisted <name> [--remove] [--create]

Add the user given to the whitelist on instances with the `sync_whitelist` option enabled.
If the `--remove` switch is used the user is removed from the whitelist.

Since whitelisted status is a part of the account data the account must exist for this to succeed, passing `--create` will create the account if it does not exist.


### Ban User

    ctl> user set-banned <name> [--reason <message>] [--pardon] [--create]

Ban user in-game from instances with the `sync_banlist` option enabled.
Reason is a message that will be shown to the user when attemption to log in.
If the `--pardon` switch is used it removes the ban.

Since ban status is a part of the account data the account must exist for this to succeed, passing `--create` will create the account if it does not exist.

Note: This bans the user from logging in to Factorio servers in the cluster, it does not revoke access to any cluster management they might have, see next section on setting roles for revoking tha.

### Bulk importing admin, whitelist and ban lists

Whitelists and admin lists can be bulk imported with the following commands:

    ctl> user whitelist-bulk-import <file> [--create]
    ctl> user admin-bulk-import <file> [--create]

The file should simply be newline seperated names:

    joe
    bob
    allan

The `--create` option will create the user if they do not exist, and then set the relevent value.

Banlists can be bulk imported with the following command:
    
    ctl> user banned-bulk-import <file> [--create]

The file should be names, followed by a ban reason:

    joe greifed copper mines
    bob stole materials
    allan rude language

The first string on the line is used as the username, the others are used as the ban reason.
The `--create` option will create the user if they do not exist, then ban them.

### Set Cluster Roles

    ctl> user set-roles <name> [roles...]

Replaces the roles the user has in the cluster with a new list of roles.
Calling with an empty roles argument will remove all roles from the user.

By default there's a roled named Cluster Admin which grants access to everything and a role named Player which grants a limited read access to the cluster, see [the section on roles](#roles) for more information about setting up roles and permissions.


### Delete user

    ctl> user delete <name>

Deletes everything stored on the controller for this user.

Note: If the player is banned from the cluster this will effectively unban them, as the ban status is stored with the user account.

Note: If the player joins the cluster again a new account will be made for them automatically.


## Roles

To be written.


## Plugins (Local)

To be written.


## Plugins (Remote)

By default, remote updates are enabled unless you selected "no" during installation.
Remote updates allow ctl and the web UI to update plugins on machines within the cluster.
However, remote installations are disabled by default to prevent the risk of arbitrary code execution through the installation of malicious npm packages onto the machine. See below if you wish to enable this feature.

### List

    ctl> controller plugin list
    ctl> host plugin list <host>

This command lists all plugins currently known to the remote. Newly installed plugins will not be displayed until the remote is restarted. Plugins that are distributed as an npm package can be updated remotely.

### Update

    ctl> controller plugin update <name> [--restart]
    ctl> host plugin update <host> <name> [--restart]

If remote plugin updates are enabled on the remote, this will execute `npm update --save <name>`. Changes will not be applied until the remote is restarted. If the `--restart` flag is provided, the remote will automatically restart once the update is complete.

### Install

    ctl> controller plugin install <name> [--restart]
    ctl> host plugin install <host> <name> [--restart]

If remote plugin installs are enabled on the remote, this will execute `npm install --save <name>`. Changes will not be applied until the remote is restarted. If the `--restart` flag is provided, the remote will automatically restart once the update is complete.

### Enable/Disable Updates

    host> config set host.allow_plugin_updates true/false
    controller> config set controller.allow_plugin_updates true/false

Remote updates are enabled by default but can be disabled on a per-machine basis at the owner's discretion. For security reasons, this configuration setting cannot be changed remotely. To modify it, run the above commands locally while the remote is offline.

### Enable/Disable Installs

    host> config set host.allow_plugin_install true/false
    controller> config set controller.allow_plugin_install true/false

Remote installs are disabled by default but can be enabled on a per-machine basis at the owner's discretion. For security reasons, this configuration setting cannot be changed remotely. To modify it, run the above commands locally while the remote is offline.
