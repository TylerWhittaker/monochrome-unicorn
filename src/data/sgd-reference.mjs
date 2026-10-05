/*
 * Zebra Printer Console -- a web console served from a Zebra printer.
 * Copyright (C) 2026 Tyler Whittaker
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * sgd-reference.mjs -- what each printer setting (SGD) is for.
 *
 * One or two sentences per setting, written for this console in our own
 * words from the SGD chapters of Zebra's ZPL II programming guide, plus a
 * few the guide leaves out but whose purpose is plain. Values and
 * defaults are not repeated: the Settings tab shows the printer's own
 * catalogue for those. tools/sgd-manual-extract.mjs splits the guide
 * into per-setting records to check this against a newer edition.
 *
 * Covers the settings of the printers this was written against (a
 * ZD500R and a ZD620); a setting not here is shown as one the guide does
 * not describe. Served as SGDREF.SHTML and read on first use.
 */

export const SGD = {};

Object.assign(SGD, {
  'alerts.add':
    'Adds an alert -- a condition, a destination and when to send it -- in one string, as ^SX does in ZPL. The condition and destination names are listed by alerts.conditions and alerts.destinations.',
  'alerts.conditions': 'The conditions an alert can be raised for (paper out, head open and so on).',
  'alerts.configured':
    'Every alert set up on the printer, separated by "|". Writing it replaces the whole list.',
  'alerts.destinations': 'The places an alert can be sent: serial, e-mail, TCP, SNMP and so on.',
  'alerts.http.authentication.add':
    'Adds a server, user name and password for HTTP POST alerts to use when that server asks for them.',
  'alerts.http.authentication.entries':
    'The servers added with alerts.http.authentication.add (names only; never the passwords).',
  'alerts.http.authentication.remove': 'Removes a server’s credentials, given just its name.',
  'alerts.http.logging.clear': 'Clears the HTTP (WebLink) alert log. Any value does it; logging carries on.',
  'alerts.http.logging.entries': 'The HTTP alert log: connection attempts, errors and the like.',
  'alerts.http.logging.max_entries': 'How many HTTP alert log entries are kept. 0 turns the log off.',
  'alerts.http.proxy':
    'The proxy for HTTP POST alerts, as a URL: http://[user:pass@]host[:port]/.',
  'alerts.tracked_settings.clear_log': 'Clears the log of changes to tracked settings. Any value does it.',
  'alerts.tracked_settings.log_tracked':
    'Settings whose changes are logged, separated by commas.',
  'alerts.tracked_settings.max_log_entries': 'How many tracked-setting log entries are kept.',
  'alerts.tracked_settings.zbi_notified':
    'Settings whose changes are passed to a running ZBI program, separated by commas.',
  'apl.enable':
    'Which Virtual Device (printer-language emulation) is active, if any -- e.g. apl-d for Datamax DPL, apl-i for Intermec IPL, pdf for PDF Direct.',
  'apl.framework_version': 'The version of the Virtual Device framework.',
  'apl.o.graphics_byte_width': 'A setting of the APL-O Virtual Device: the byte width it uses for graphics.',
  'apl.settings':
    'Options for PDF Direct, such as dither, scale-to-fit and orientation; several can be given together.',
  'apl.version': 'The version of the Virtual Device system.',
  'appl.bootblock': 'The boot block version, shown as the hardware ID on the configuration label.',
  'appl.date': 'The date the firmware was built.',
  'appl.dl_id': 'An identifier for the firmware download that is installed.',
  'appl.link_os_version': 'The Link-OS feature level the firmware supports.',
  'appl.name': 'The firmware version, e.g. V74.20.23Z.',
  'appl.version': 'The firmware version number.',
  'bluetooth.address': 'The printer’s Bluetooth address.',
  'bluetooth.allow_non_display_numeric_comparison':
    'For printers without a display: whether Bluetooth numeric-comparison pairing is allowed, and whether the passkey is printed for it.',
  'bluetooth.bluetooth_pin':
    'The PIN a device must give to connect, when bluetooth.authentication is "setpin". Write-only.',
  'bluetooth.bonding': 'Whether paired devices are remembered (bonded) so they can reconnect.',
  'bluetooth.clear_bonding_cache': 'Forgets every Bluetooth device the printer has been paired with.',
  'bluetooth.connected': 'Whether a Bluetooth device is connected now.',
  'bluetooth.connected_security_mode': 'The security mode of the current Bluetooth connection.',
  'bluetooth.date': 'The release date of the Bluetooth module.',
  'bluetooth.discoverable': 'Whether the printer can be found by devices searching for Bluetooth printers.',
  'bluetooth.enable': 'Turns the Bluetooth radio on or off.',
  'bluetooth.enable_reconnect': 'The reconnect feature iOS devices need; "iOS_only" enables it for them.',
  'bluetooth.friendly_name':
    'The name the printer shows other devices over Bluetooth. Takes effect after a restart.',
  'bluetooth.json_config_channel_enable':
    'Whether the Bluetooth JSON configuration channel is offered. Takes effect after a restart.',
  'bluetooth.le.controller_mode': 'Bluetooth Classic, Low Energy, or both, on radios that can do both.',
  'bluetooth.local_name': 'The name given during Bluetooth service discovery.',
  'bluetooth.minimum_security_mode':
    'The lowest Bluetooth security mode the printer accepts, from 1 (no PIN) to 4 (encrypted, authenticated pairing).',
  'bluetooth.page_scan_window': 'The Bluetooth page scan window, 15 or 60 ms.',
  'bluetooth.power_class': 'The radio’s maximum transmit power class.',
  'bluetooth.radio_version': 'The Bluetooth version of the radio fitted.',
  'bluetooth.short_address': 'The Bluetooth address without its colons.',
  'bluetooth.version': 'The version of the printer’s Bluetooth software.',
  'capture.channel1.count':
    'How many times the capture delimiter has been seen on the capture port (or the maximum length reached).',
  'capture.channel1.delimiter':
    'Marks where one piece of captured input ends -- e.g. a carriage return after each barcode scan.',
  'capture.channel1.max_length':
    'How much captured input is taken as one piece when no delimiter has arrived.',
  'capture.channel1.port':
    'Which port to capture input from (a scanner or keyboard plugged into the printer) instead of printing it; off is normal printing.',
  'card.cardid': 'An identifier read from the wireless card.',
  'card.cisproc': 'Card Information Structure (CIS) details read from the wireless card.',
  'card.cor': 'The wireless card’s configuration option register.',
  'card.defcfg': 'The wireless card’s default configuration.',
  'card.enable': 'Whether the wireless card is used.',
  'card.fcrbase': 'The base address of the wireless card’s configuration registers.',
  'card.fcrlist': 'The wireless card’s configuration registers.',
  'card.fncode': 'The function code read from the wireless card.',
  'card.idtext1': 'Identification text read from the wireless card (line 1).',
});

Object.assign(SGD, {
  'card.idtext2': 'Identification text read from the wireless card (line 2).',
  'card.idtext3': 'Identification text read from the wireless card (line 3).',
  'card.idtext4': 'Identification text read from the wireless card (line 4).',
  'card.inserted': 'Whether a wireless radio card is fitted.',
  'card.mac_addr': 'The wireless card’s MAC address.',
  'card.mac_raw': 'The wireless card’s MAC address without separators.',
  'card.mfgid': 'The wireless card’s manufacturer ID.',
  'comm.baud': 'The serial port’s speed. The computer on the other end must be set to match.',
  'comm.data_bits': 'Data bits per character on the serial port.',
  'comm.dsr': 'Whether the serial port’s DSR line is raised.',
  'comm.handshake': 'Serial flow control: XON/XOFF in the data, or the RTS/CTS or DSR/DTR lines.',
  'comm.parity': 'Serial parity: none, odd or even. The other end must match.',
  'comm.stop_bits': 'Serial stop bits. The other end must match.',
  'comm.type': 'Whether the serial port acts as DTE, DCE, or detects which.',
  'cutter.clean_cutter': 'Whether the cutter-cleaning option is on.',
  'device.allow_firmware_downloads': 'Whether new firmware may be downloaded to the printer.',
  'device.bluetooth_installed': 'Whether a Bluetooth radio is fitted.',
  'device.command_override.active':
    'Whether the commands on the override list (device.command_override.add) are ignored.',
  'device.command_override.add':
    'Adds a ZPL command or setting to the list the printer ignores -- to stop jobs changing, say, darkness. Kept across restarts.',
  'device.command_override.clear': 'Empties the list of ignored commands.',
  'device.command_override.list': 'The commands the printer is set to ignore.',
  'device.company_contact': 'Contact details shown on the printer’s web pages.',
  'device.company_name': 'The manufacturer’s name.',
  'device.configuration_number': 'The printer’s configuration (SKU) number.',
  'device.cph_enable': 'Whether the printer reports its status periodically (the "cph" heartbeat).',
  'device.cph_interval': 'Seconds between periodic status reports when device.cph_enable is on.',
  'device.current_configuration_number': 'The configuration number of the options now installed.',
  'device.cutter_installed': 'Whether a cutter is fitted.',
  'device.diagnostic_print': 'Whether diagnostic printing is turned on.',
  'device.download_connection_timeout':
    'Seconds without data after which a firmware download is abandoned; 0 waits for ever.',
  'device.epl_legacy_mode':
    'Makes EPL label positioning behave like the old 2824/2844 printers.',
  'device.feature.802_11ac': 'Whether an 802.11ac wireless radio is fitted.',
  'device.feature.applicator': 'Whether an applicator interface is fitted.',
  'device.feature.bluetooth_le': 'Whether a Bluetooth Low Energy radio is fitted.',
  'device.feature.head_element_test': 'Whether the printer can test its printhead elements.',
  'device.feature.lighted_arrows': 'Whether the lighted media-loading arrows are fitted.',
  'device.feature.lock': 'Whether a locking media cover is fitted.',
  'device.feature.mfi': 'Whether Apple MFi (Made for iPhone) Bluetooth support is fitted.',
  'device.feature.ribbon_cartridge': 'Whether the printer takes a ribbon cartridge, and has one in.',
  'device.ff_disable': 'Disables the front-panel Feed button.',
  'device.friendly_name': 'The printer’s name, shown in the console’s header and on the network.',
  'device.frontpanel.key_press':
    'Presses a front-panel button, by letter (which letter is which varies by model).',
  'device.frontpanel.line1': 'Replaces the first line of the idle display with your own text.',
  'device.frontpanel.line2': 'Replaces the second line of the idle display with your own text.',
  'device.frontpanel.line3': 'Replaces the third line of the idle display with your own text.',
  'device.frontpanel.line4': 'Replaces the fourth line of the idle display with your own text.',
  'device.host_identification': 'What ~HI reports: model, firmware, resolution, memory and options.',
  'device.host_status':
    'What ~HS reports: three lines of status flags (paper out, paused, head open, ribbon out, labels waiting…). The console’s status pill reads it.',
  'device.idle_display_format':
    'What the idle display shows: the firmware version, the IP address, or the date and time in a chosen format.',
  'device.idle_display_value': 'What the idle display is showing now.',
  'device.internal_wired_setting_location': 'Where the internal wired network settings are kept.',
  'device.job_log.total_jobs': 'How many jobs the printer has logged.',
  'device.jobs_print': 'How many jobs are waiting to print.',
  'device.languages':
    'Which label languages the printer parses -- ZPL, EPL, both, or ZPL with XML. A format in a language it is not set for prints nothing.',
  'device.location': 'Where the printer is, shown on its web pages.',
  'device.locked': 'Whether the printer is locked.',
  'device.macro_get': 'Macros stored on the printer.',
  'device.mcu_communication.desired_revision': 'The communication MCU revision the firmware expects.',
  'device.mcu_communication.revision': 'The revision of the microcontroller that handles communication.',
  'device.mcu_cutter.desired_revision': 'The cutter MCU revision the firmware expects.',
  'device.mcu_cutter.revision': 'The revision of the cutter’s microcontroller.',
  'device.oem.home_url': 'The manufacturer’s web address, as the printer reports it.',
  'device.oem.manufacturer_name': 'The manufacturer’s name, as the printer reports it.',
  'device.oem.model_name': 'The model name, as the printer reports it.',
  'device.oem.support_url': 'The support web address, as the printer reports it.',
  'device.pause': 'Pauses after the current label, as ~PP does.',
  'device.pmcu.desired_revision': 'The power MCU revision the firmware expects.',
  'device.pmcu.revision': 'The revision of the power-management microcontroller.',
  'device.pnp_option': 'Whether the plug-and-play reply describes a ZPL or an EPL printer. Takes effect after a restart.',
  'device.pnp_string': 'The plug-and-play string the printer sends a computer.',
});

Object.assign(SGD, {
  'device.position.accuracy': 'How accurate the stored location is, in the units of whatever supplied it.',
  'device.position.altitude': 'The printer’s altitude in metres above (or, negative, below) sea level.',
  'device.position.latitude': 'The printer’s latitude, in decimal degrees.',
  'device.position.longitude': 'The printer’s longitude, in decimal degrees.',
  'device.print_geometry_revision': 'The revision of the print geometry the firmware uses.',
  'device.print_out_report':
    'Prints a report: the settings, network, stored formats, images, fonts and so on.',
  'device.print_reprogram_2key':
    'Whether a configuration label prints when the printer restarts after a firmware update.',
  'device.printhead.resolution': 'The printhead’s resolution, in dots per millimetre.',
  'device.printhead.serialnum': 'The printhead’s serial number.',
  'device.printhead.test.summary': 'A summary of the printhead test results, as ~HQJT reports.',
  'device.product_name': 'The printer’s model name, e.g. ZD500R.',
  'device.product_name_submodel': 'The model variant, e.g. a healthcare version.',
  'device.prompted_network_reset':
    'Restarts the network card and print server, which then rejoin the network.',
  'device.protected_mode': 'Whether Protected Mode (locked-down configuration) is on.',
  'device.protected_mode_allowed': 'Whether this printer supports Protected Mode.',
  'device.reset': 'Restarts the printer, as switching it off and on would.',
  'device.reset_button_enable': 'Whether the printer’s reset button works.',
  'device.restore_defaults':
    'Puts one branch of settings back to factory defaults -- ip, wlan, display, bluetooth, power, or all.',
  'device.sensor_profile': 'Where the media sensor profile goes: printed, stored, or sent back.',
  'device.sensor_select': 'Which media sensor is used: reflective (black marks) or transmissive (gaps), as ^JS.',
  'device.serial_numbers.control_panel': 'The control panel’s serial number.',
  'device.serial_numbers.control_panel_date': 'When the control panel was made.',
  'device.serial_numbers.cutter': 'The cutter’s serial number, if one is fitted.',
  'device.serial_numbers.cutter_date': 'When the cutter was made.',
  'device.serial_numbers.mlb': 'The main logic board’s serial number.',
  'device.serial_numbers.mlb_date': 'When the main logic board was made.',
  'device.serial_numbers.option_board': 'The option board’s serial number.',
  'device.serial_numbers.option_board_date': 'When the option board was made.',
  'device.set_clock_to_build_date':
    'If the clock reads earlier than the firmware’s build date at power-up, set it to that date.',
  'device.slot_1': 'Which board is in the expansion slot.',
  'device.status': 'Whether the printer is ready or busy.',
  'device.syslog.clear_log': 'Clears the syslog kept on the printer.',
  'device.syslog.configuration':
    'Where syslog messages go, and from what severity: the printer itself, or a syslog server’s address.',
  'device.syslog.enable': 'Turns syslog messages on or off.',
  'device.syslog.entries': 'The syslog messages kept on the printer.',
  'device.syslog.log_max_file_size': 'The largest the printer’s own syslog may grow, in bytes.',
  'device.syslog.save_local_file': 'Also saves the printer’s syslog to E:SYSLOG.TXT.',
  'device.unique_id': 'The printer’s serial number.',
  'device.unpause': 'Takes the printer out of pause, as ~PS does.',
  'device.uptime': 'How long the printer has been on.',
  'device.user_p1': 'A spare value for your own use (up to 20 characters), kept on the printer.',
  'device.user_p2': 'A second spare value for your own use.',
  'device.user_vars.create':
    'Creates a setting of your own under device.user_vars: "name:type:range:default", e.g. "count:INTEGER:1-100:5". Gone at power-off.',
  'device.user_vars.set_range': 'Changes the range of a setting made with device.user_vars.create.',
  'device.xml.enable': 'Whether the printer also parses XML-formatted jobs.',
  'display.backlight': 'Whether the display’s backlight is used.',
  'display.backlight_on_time': 'Seconds of inactivity before the backlight goes off; 0 keeps it on.',
  'display.batch_counter': 'Whether batch counters are shown on the display.',
  'display.contrast': 'The display’s contrast.',
  'display.language': 'The control panel’s language, as ^KL.',
  'display.load_card':
    'Shows a menu card from a WML file on the display, e.g. "MENU.WML#main" (the card name is case sensitive). Reading it says which is on screen.',
  'display.orientation': 'Which way up the display is drawn.',
  'display.password.current': 'Sets the front-panel password (four digits). Write-only.',
  'display.password.input': 'Enters a password, as if typed on the front panel.',
  'display.password.length': 'How many digits the front-panel password has.',
  'display.password.level':
    'When the front panel asks for the password: for every setting changed, only for selected ones, or never.',
  'display.password.type': 'What the front-panel password is made of (digits).',
  'display.previous_displayed_card': 'The menu card shown before the current one.',
  'display.root_wml': 'The WML file the front panel starts from: its home menu.',
  'display.status_bar_suppress': 'Hides the status bar on the display.',
  'display.suppress_all_alerts': 'Stops alerts appearing on the display.',
  'ezpl.head_close_action':
    'What the printer does with the media when the head is closed: feed, calibrate, measure, short calibration or nothing (as ^MF).',
  'ezpl.label_length_max':
    'The longest label calibration looks for, in inches (as ^ML). Must be at least the real label length.',
  'ezpl.label_sensor': 'The media sensor’s paper-out threshold.',
  'ezpl.manual_calibration': 'Starts a manual media calibration; reads whether one is in progress.',
  'ezpl.media_type': 'The media loaded: continuous, gap/notch, black mark, or detected (as ^MN).',
  'ezpl.power_up_action':
    'What the printer does with the media at power-up: feed, calibrate, measure, short calibration or nothing (as ^MF).',
  'ezpl.print_method': 'Thermal transfer (with ribbon) or direct thermal (as ^MT).',
  'ezpl.print_mode': 'What happens after a label prints: tear off, peel, rewind, cut… (as ^MM).',
  'ezpl.print_width': 'The print width in dots (as ^PW). A new label in the editor takes this width.',
});

Object.assign(SGD, {
  'ezpl.reprint_mode': 'Reprint mode: after an error, or on request, the last label prints again.',
  'ezpl.restore_defaults': 'Reloads the factory printer settings, or the factory network settings.',
  'ezpl.take_label': 'The brightness of the sensor that sees whether a peeled label has been taken.',
  'ezpl.tear_off': 'Moves where the media stops after printing, for tearing or cutting, in dot rows (as ~TA).',
  'file.append': 'Appends data to a stored file.',
  'file.capture_response.begin': 'Starts saving everything the printer sends back to a file.',
  'file.capture_response.destination': 'Where captured responses are saved: a file on the printer, or a USB drive.',
  'file.capture_response.end': 'Stops saving the printer’s responses to a file.',
  'file.delete':
    'Deletes a stored file, e.g. "E:OLD.ZPL" -- without the password, and including types the web delete refuses. The console’s File System deletes this way.',
  'file.dir_format': 'Whether file.dir lists in ZPL or CPCL style.',
  'file.drive_info': 'Each drive’s size and free space, as JSON.',
  'file.drive_listing':
    'Every stored file on every drive, with sizes, dates and real extensions, as JSON. Slow to read (about nine seconds); the File System tab is built from it.',
  'file.print': 'Prints a stored format, e.g. "E:LABEL.ZPL".',
  'file.rename': 'Renames a stored file: "old name" "new name".',
  'file.run':
    'Sends a stored file to the printer to be acted on as if it had arrived on a port -- how a .BAT is run.',
  'file.type':
    'Sends back a stored file’s contents -- to the port that asked, so it does not work through the web server.',
  'formats.cancel_all': 'Cancels every format waiting to print and any batch in progress, as ~JA.',
  'head.darkness_switch': 'Where the darkness switch at the back of a desktop printer is set: low, medium or high.',
  'head.darkness_switch_enable': 'Whether the darkness switch is used.',
  'head.element_test':
    'Runs the printhead element test; reading it gives the last result ("Head Elements OK" or the failed elements).',
  'head.latch': 'Whether the printhead is closed ("ok") or open. The console’s status pill reads it.',
  'head.resolution.in_dpi':
    'The printhead’s resolution in dots per inch. The console converts every inch and millimetre with it.',
  'input.capture':
    'Diagnostic capture of incoming data: print it, run it, save it to a USB drive, or off.',
  'interface.network.active.arp_interval': 'Minutes between ARP broadcasts on the active network; 0 none.',
  'interface.network.active.cable_type': 'The kind of network in use: wired 10/100, or which wireless standard.',
  'interface.network.active.default_addr_enable':
    'Whether the active interface falls back to a default IP address when it gets none.',
  'interface.network.active.dhcp_received_host_name': 'The host name DHCP assigned, if any.',
  'interface.network.active.gateway': 'The default gateway of the network in use.',
  'interface.network.active.ip_addr': 'The IP address of the network in use.',
  'interface.network.active.mac_addr': 'The MAC address of the network interface in use.',
  'interface.network.active.mac_raw': 'The same MAC address without its colons.',
  'interface.network.active.netmask': 'The subnet mask of the network in use.',
  'interface.network.active.printserver': 'Which interface is in use: wired or wireless.',
  'interface.network.active.protocol': 'How the active interface gets its address: DHCP, BOOTP, permanent and so on.',
  'interface.network.active.protocol_error': 'The last error from the active interface’s address protocol.',
  'interface.network.active.rx_errors': 'Receive errors on the active interface since power-up.',
  'interface.network.active.rx_packets': 'Packets received on the active interface since power-up.',
  'interface.network.active.server_address': 'The server that gave the printer its IP address.',
  'interface.network.active.server_protocol': 'The protocol by which the address was given.',
  'interface.network.active.speed': 'The active link’s speed in megabits a second.',
  'interface.network.active.tx_errors': 'Transmit errors on the active interface since power-up.',
  'interface.network.active.tx_packets': 'Packets sent on the active interface since power-up.',
  'interface.network.active.wins_addr': 'The WINS server address of the network in use.',
  'interface.network.settings_require_reset':
    'Whether network settings have been changed that need a network or printer reset to take effect.',
  'internal_wired.activity_led': 'Whether the Ethernet activity light blinks or stays on.',
  'internal_wired.auto_switchover':
    'Switch from wireless to the wired network when an Ethernet cable with a live network is plugged in.',
  'internal_wired.enable': 'Turns the wired network interface on or off. Needs a reset.',
  'internal_wired.installed': 'Whether a wired network interface is fitted.',
  'internal_wired.link': 'Whether the wired network cable has a link.',
});

/*
 * The IP settings, which the wired and wireless interfaces each have a
 * copy of, with the same meaning.
 */
const IP_SETTINGS = {
  addr: 'The {if} IP address. A set address only takes effect with the protocol set to permanent, after a reset.',
  arp_interval: 'Minutes between ARP broadcasts on the {if} network; 0 none.',
  default_addr_enable: 'Whether the {if} interface falls back to a default IP address when it gets none.',
  'dhcp.arp_verify': 'Whether the {if} interface checks by ARP that an address DHCP gave it is not in use.',
  'dhcp.cache_ip': 'Keep the last DHCP address for the {if} interface, to reuse if no DHCP server answers.',
  'dhcp.cid_all': 'The whole DHCP client identifier (option 61) for the {if} interface, when its type is ASCII or hex.',
  'dhcp.cid_enable': 'Whether the {if} interface sends a DHCP client identifier (option 61).',
  'dhcp.cid_prefix': 'Text put before the {if} DHCP client identifier.',
  'dhcp.cid_suffix': 'The unique part of the {if} DHCP client identifier.',
  'dhcp.cid_type': 'What the {if} DHCP client identifier is: 0 ASCII text, 1 the MAC address, 2 hex.',
  'dhcp.lease.last_attempt': 'When the {if} interface last asked for a DHCP lease.',
  'dhcp.lease.length': 'The length of the {if} DHCP lease, in seconds.',
  'dhcp.lease.server': 'The DHCP server that gave the {if} lease.',
  'dhcp.lease.time_left': 'Seconds left on the {if} DHCP lease.',
  'dhcp.option12': 'Whether the {if} interface sends its host name (DHCP option 12).',
  'dhcp.option12_format': 'The host name the {if} interface sends in DHCP option 12, which may include fields.',
  'dhcp.option12_value': 'The host name the {if} interface actually sends in DHCP option 12.',
  'dhcp.required': 'Whether the {if} interface must get its address by DHCP.',
  'dns.domain': 'The DNS domain of the {if} network.',
  'dns.servers': 'The DNS servers of the {if} network.',
  gateway: 'The {if} default gateway. Takes effect with the protocol set to permanent, after a reset.',
  netmask: 'The {if} subnet mask. Takes effect with the protocol set to permanent, after a reset.',
  protocol: 'How the {if} interface gets its address: DHCP, BOOTP, both, permanent (fixed) or all.',
  'timeout.enable': 'Whether idle connections on the {if} interface are closed.',
  'timeout.value': 'Seconds before an idle connection on the {if} interface is closed.',
  'wins.addr': 'The {if} WINS server address.',
  'wins.permanent_source': 'Whether the {if} WINS address is fixed rather than taken from DHCP.',
};

const IEEE_8021X = {
  password: 'The password for {if} 802.1X authentication. Write-only.',
  'peap.anonymous_identity': 'The outer (phase 1) identity for {if} PEAP authentication.',
  'peap.validate_server_certificate':
    'With PEAP, whether the {if} server’s certificate must be signed by a trusted certificate authority.',
  privkey_password: 'The password of the {if} private key, for EAP-TLS. Write-only.',
  security: 'The {if} 802.1X security type: none, PEAP, EAP-TLS or EAP-TTLS.',
  ttls_tunnel: 'The inner protocol for {if} EAP-TTLS: PAP, CHAP, MSCHAP or MSCHAPv2.',
  username: 'The user name for {if} 802.1X authentication.',
};

for (const [prefix, label] of [
  ['internal_wired', 'wired'],
  ['wlan', 'wireless'],
]) {
  for (const [suffix, text] of Object.entries(IP_SETTINGS)) {
    SGD[`${prefix}.ip.${suffix}`] = text.replace('{if}', label);
  }
  SGD[`${prefix}.mac_addr`] = `The ${label} interface’s MAC address.`;
  SGD[`${prefix}.mac_raw`] = `The ${label} interface’s MAC address without its colons.`;
}
for (const [suffix, text] of Object.entries(IEEE_8021X)) {
  SGD[`internal_wired.8021x.${suffix}`] = text.replace('{if}', 'wired');
}
for (const suffix of ['peap.anonymous_identity', 'peap.validate_server_certificate', 'ttls_tunnel']) {
  SGD[`wlan.8021x.${suffix}`] = IEEE_8021X[suffix].replace('{if}', 'wireless');
}

Object.assign(SGD, {
  'ip.active_network': 'Which network the printer is using: wireless, external wired or internal wired.',
  'ip.dhcp.auto_provision_enable': 'Lets the printer take its WebLink (cloud) settings from the DHCP server.',
  'ip.dhcp.ntp.enable': 'Ask the DHCP server for a time (NTP) server address.',
  'ip.dhcp.ntp.received_servers': 'The time (NTP) servers the DHCP server gave.',
  'ip.dhcp.user_class_id': 'The DHCP user class ID the printer sends.',
  'ip.dhcp.vendor_class_id': 'The DHCP vendor class ID the printer sends.',
  'ip.discovery.enable': 'Whether the printer answers Zebra network discovery.',
  'ip.discovery.port': 'The UDP port the printer answers discovery on.',
  'ip.firewall.whitelist_in':
    'The addresses (or ranges) allowed to talk to the printer, separated by commas; empty allows all.',
  'ip.ftp.enable': 'Turns the printer’s FTP server on or off.',
  'ip.ftp.execute_file': 'Whether files sent by FTP are acted on (printed) as well as stored.',
  'ip.ftp.request_password': 'Whether FTP asks for a password at the start of a session.',
  'ip.http.admin_name': 'The user name for the printer’s own web pages.',
  'ip.http.admin_password': 'The password for the printer’s own web pages.',
  'ip.http.custom_link_name': 'The text of a custom link on the printer’s web pages.',
  'ip.http.custom_link_url': 'Where that custom link goes.',
  'ip.http.enable':
    'Turns the printer’s web server on or off. Off, this console cannot be reached either.',
  'ip.http.faq_url': 'The FAQ link on the printer’s web pages.',
  'ip.http.port': 'The port the web server listens on (normally 80).',
  'ip.https.enable': 'Turns HTTPS on or off. Needs a reset.',
  'ip.https.port': 'The port HTTPS listens on (normally 443).',
  'ip.lpd.enable': 'Turns LPD printing (port 515) on or off.',
  'ip.ntp.enable': 'Set the printer’s clock from time (NTP) servers.',
  'ip.ntp.log': 'The time-server status and error log.',
  'ip.ntp.servers': 'The time (NTP) servers to use, separated by commas.',
  'ip.ping_gateway_interval': 'Minutes between pings to the default gateway, to keep the connection alive; 0 none.',
  'ip.ping_len': 'The size of the ping packets sent with ip.ping_remote.',
  'ip.ping_remote': 'Pings an address from the printer, to test the network.',
  'ip.pop3.enable': 'Check a POP3 mailbox and print what arrives.',
  'ip.pop3.password': 'The POP3 mailbox password.',
  'ip.pop3.poll': 'Seconds between checks of the POP3 mailbox.',
  'ip.pop3.print_attachments': 'Print attachments of mail fetched by POP3.',
  'ip.pop3.print_body': 'Print the body of mail fetched by POP3.',
  'ip.pop3.print_headers': 'Print the headers of mail fetched by POP3.',
  'ip.pop3.save_attachments': 'Save attachments of mail fetched by POP3 to the printer’s flash.',
  'ip.pop3.server_addr': 'The POP3 server’s address.',
  'ip.pop3.username': 'The POP3 mailbox user name.',
  'ip.pop3.verbose_headers': 'Print the full (verbose) mail headers.',
  'ip.port':
    'The raw TCP printing port (normally 9100) -- the one tools/upload.mjs and the LCD helper use.',
  'ip.port_alternate': 'A second raw printing port, listened on as well as ip.port.',
  'ip.port_json_config': 'The port for JSON configuration commands; 0 turns it off.',
  'ip.port_single_conn': 'A printing port that accepts one connection at a time.',
  'ip.port_single_conn_idle_timeout': 'Seconds of silence before that single connection counts as idle.',
  'ip.primary_network': 'Which network is preferred: 1 wired, 2 wireless.',
  'ip.remote': 'The address used by ip.ping_remote.',
  'ip.roam_packet': 'Whether a packet is sent after roaming between access points, to update the network.',
  'ip.smtp.domain': 'The mail domain the printer uses when sending e-mail alerts.',
  'ip.smtp.enable': 'Whether the printer can send e-mail (for alerts).',
  'ip.smtp.server_addr': 'The SMTP server for e-mail alerts.',
  'ip.snmp.create_mib': 'Creates the printer’s SNMP MIB file.',
  'ip.snmp.enable': 'Turns SNMP on or off.',
  'ip.snmp.get_community_name': 'The SNMP community name for reading.',
  'ip.snmp.set_community_name': 'The SNMP community name for writing.',
  'ip.snmp.trap_community_name': 'The SNMP community name for traps.',
  'ip.tcp.enable': 'Turns raw TCP printing on or off.',
  'ip.tcp.nagle_algorithm': 'Whether TCP connections use the Nagle algorithm (fewer, larger packets).',
  'ip.tls.enable': 'Turns on the encrypted (TLS) printing and JSON configuration ports.',
  'ip.tls.port': 'The port for encrypted (TLS) printing.',
  'ip.tls.port_json_config': 'The port for encrypted JSON configuration.',
  'ip.udp.enable': 'Turns UDP printing on or off.',
  'ip.mirror.freq': 'Minutes between Mirror updates from the server; 0 none.',
  'ip.mirror.freq_hours': 'Hours between Mirror updates from the server; 0 none.',
  'ip.mirror.feedback.freq': 'Minutes between feedback uploads to the Mirror server.',
  'ip.mirror.interface': 'Which network Mirror uses: wired, wireless or both.',
  'ip.mirror.mode': 'Whether Mirror uses FTP or SFTP.',
  'ip.mirror.password': 'The Mirror server password.',
  'ip.mirror.server': 'The Mirror server’s address.',
  'ip.mirror.username': 'The Mirror server user name.',
  'ip.mirror.version': 'The build date of the printer’s Mirror code.',
});

/*
 * Mirror keeps a printer's firmware, files and settings in step with a
 * directory -- on a server (ip.mirror) or a USB drive (usb.mirror).
 */
const MIRROR = {
  appl_path: 'Where Mirror looks for firmware, instead of the "appl" directory under the path.',
  auto: 'Run a Mirror update at power-up.',
  error_retry: 'How many times a failed Mirror update is retried.',
  'feedback.auto': 'Upload a feedback file after each Mirror update.',
  'feedback.odometer': 'A counter included in the Mirror feedback file.',
  'feedback.path': 'Where the Mirror feedback file is put.',
  fetch: 'Runs a Mirror update now.',
  last_error: 'The last error from a Mirror update.',
  last_time: 'When a Mirror update was last tried.',
  path: 'The directory Mirror updates from.',
  reset_delay: 'Seconds to wait after the last command file before restarting, during a Mirror update.',
  success: 'Whether the last Mirror update succeeded.',
  success_time: 'When a Mirror update last succeeded.',
};
for (const [suffix, text] of Object.entries(MIRROR)) {
  SGD[`ip.mirror.${suffix}`] = `${text} (Network.)`;
  SGD[`usb.mirror.${suffix}`] = `${text} (USB drive.)`;
}

Object.assign(SGD, {
  'log.reboot.code': 'Why the printer last restarted, as a one-character code (see log.reboot.reason).',
  'log.reboot.codes': 'The reasons for the last 32 restarts, one code each.',
  'log.reboot.reason': 'Why the printer last restarted, in words: a device.reset, a Mirror update, a power loss…',
  'media.backfeed':
    'When a label is pulled back after printing: before the next one (B), after (A), normal (N), off (O), or a percentage of each (as ~JS).',
  'media.bar_location': 'Whether black marks are on the front or the back of the media.',
  'media.cut_now': 'Cycles the cutter now.',
  'media.dynamic_length_calibration':
    'Adjust to small variations in label length while printing (as ^XS).',
  'media.part_number': 'The part number of the media loaded, for your records.',
  'media.printmode': 'What happens after a label prints: tear off, peel, rewind, cut, kiosk… (as ^MM).',
  'media.sense_mode': 'Whether labels are found by black mark (bar) or by the gap between them.',
  'media.serial_number': 'The serial number of the media loaded, for your records.',
  'media.speed': 'Print speed, in inches a second (as ^PR). "up" and "down" step it by one.',
  'media.status': 'Whether there is media: "ok", or "out". The console’s status pill reads it.',
  'media.thermal_mode': 'Direct thermal (DT) or thermal transfer with ribbon (TT).',
  'media.tof':
    'For black-mark or gap media: dots from the mark or gap to where labels separate.',
  'media.type': 'Whether the media is labels or continuous journal (receipt) paper.',
  'memory.flash_free': 'Free flash memory (the E: drive), in bytes.',
  'memory.flash_size': 'Total flash memory, in bytes.',
  'memory.ram_free': 'Free RAM, in bytes.',
  'memory.ram_size': 'Total RAM, in bytes.',
  'netmanage.avalanche.agent_addr': 'The address of the Avalanche device-management agent.',
  'netmanage.avalanche.available_agent': 'The Avalanche agent found by discovery.',
  'netmanage.avalanche.available_port': 'The port of the Avalanche agent found by discovery.',
  'netmanage.avalanche.encryption_type': 'The encryption used with Avalanche: none, Limburger or AES-128.',
  'netmanage.avalanche.interval': 'Milliseconds between Avalanche updates.',
  'netmanage.avalanche.interval_update': 'Whether the printer checks in with Avalanche at that interval.',
  'netmanage.avalanche.model_name': 'The model name reported to Avalanche.',
  'netmanage.avalanche.realtime_update_int': 'Milliseconds between Avalanche real-time updates.',
  'netmanage.avalanche.set_property': 'Sets a custom Avalanche device property, as "NAME=value".',
  'netmanage.avalanche.startup_update': 'Check in with Avalanche at power-up.',
  'netmanage.avalanche.tcp_connection_timeout': 'Milliseconds to wait when connecting to the Avalanche agent.',
  'netmanage.avalanche.terminal_id': 'The terminal ID Avalanche assigned the printer.',
  'netmanage.avalanche.text_msg.beep': 'Beep when an Avalanche text message arrives.',
  'netmanage.avalanche.text_msg.display': 'Show Avalanche text messages on the display.',
  'netmanage.avalanche.text_msg.print': 'Print Avalanche text messages.',
  'netmanage.avalanche.udp_timeout': 'The Avalanche UDP timeout, in milliseconds.',
  'netmanage.error_code': 'The Avalanche client’s error code.',
  'netmanage.state_code': 'The Avalanche client’s state code.',
  'netmanage.status_code': 'The Avalanche client’s status code.',
  'netmanage.type': 'Which network management system is used, if any (Avalanche).',
  'odometer.headclean': 'Media through the printer since the head was last cleaned. Set to 0 after cleaning.',
  'odometer.headnew': 'Media through the printer since the head was replaced. Set to 0 after replacing it.',
  'odometer.label_dot_length': 'The length of the last label printed or fed, in dots.',
  'odometer.latch_open_count': 'How many times the printhead has been opened.',
  'odometer.media_marker_count': 'Media through the printer over its life, not resettable.',
  'odometer.media_marker_count1': 'A resettable media counter (the first of two). Set to 0 to reset.',
  'odometer.media_marker_count2': 'A second resettable media counter.',
  'odometer.net_media_length': 'Media used over the printer’s life: forward motion less backfeed.',
  'odometer.net_ribbon_length': 'Ribbon used over the printer’s life.',
  'odometer.rfid.valid_resettable': 'RFID labels encoded successfully. Set to 0 to reset.',
  'odometer.rfid.void_resettable': 'RFID labels voided. Set to 0 to reset.',
  'odometer.total_cuts': 'Cuts made over the printer’s life.',
  'odometer.total_label_count': 'Labels printed over the printer’s life (not counting feeds).',
  'odometer.total_print_length': 'Media moved over the printer’s life, feeds included.',
  'odometer.user_label_count': 'Labels printed since this counter was last reset.',
  'odometer.user_label_count1': 'Labels printed since the first resettable counter was reset (~RO1).',
  'odometer.user_label_count2': 'Labels printed since the second resettable counter was reset (~RO2).',
  'odometer.user_total_cuts': 'Cuts since this counter was last reset. Set to 0 to reset.',
  'power.energy_star.enable': 'Go into a low-power state after a period idle (Energy Star).',
  'power.energy_star.timeout': 'Seconds idle before the low-power state.',
  'power.hold_cur': 'Keep the motor powered while idle, which holds narrow media in place.',
  'power.power_on_mode': 'Whether the printer switches itself on when power is connected.',
  'print.legacy_compatibility': 'Use the print-quality tables of older printers.',
  'print.tone':
    'Print darkness, 0 to 30. A value with + or - adjusts the current darkness instead.',
  'print.tone_format': 'Which darkness scale print.tone uses.',
  'print.tone_zpl': 'Print darkness on the ZPL scale (as ~SD).',
  'print.troubleshooting_label_choices': 'Which troubleshooting labels can be printed.',
  'print.troubleshooting_label_print': 'Prints a troubleshooting label.',
});

Object.assign(SGD, {
  'rfid.adaptive_antenna': 'Let the printer pick the best antenna element for each RFID tag.',
  'rfid.antenna_sweep': 'Try each antenna in turn to find the RFID tag.',
  'rfid.country_code': 'The RFID country, which sets the radio frequencies allowed (within the region code).',
  'rfid.enable': 'Turns RFID on or off. Needs a restart.',
  'rfid.error.response': 'The RFID status, with any error code or message.',
  'rfid.error_handling': 'What happens when a tag cannot be encoded: drop the job, pause, or carry on (as ^RS).',
  'rfid.hop_table_version': 'The version of the RFID reader’s frequency-hopping table.',
  'rfid.label_tries': 'How many labels to try before an RFID error stops the job (as ^RS).',
  'rfid.log.clear': 'Clears the RFID log.',
  'rfid.log.enabled': 'Turns the RFID log on or off.',
  'rfid.position.program':
    'Where on the label the tag is programmed: millimetres forward (F) or backward (B) from the leading edge, or dots.',
  'rfid.reader_1.antenna_port': 'Which RFID antenna to use.',
  'rfid.reader_1.firmware_version': 'The RFID reader’s firmware version.',
  'rfid.reader_1.hardware_version': 'The RFID reader’s hardware version.',
  'rfid.reader_1.model': 'The RFID reader’s model.',
  'rfid.reader_1.power.read': 'The RFID read power, when calibration has not found a good level.',
  'rfid.reader_1.power.write': 'The RFID write power, when calibration has not found a good level.',
  'rfid.recipe_version': 'The version of the RFID recipe file, which tunes encoding per tag type.',
  'rfid.region_code': 'The region the RFID reader is licensed for.',
  'rfid.tag.calibrate': 'Runs RFID tag calibration (as ^HR), or restores the default positions.',
  'rfid.tag.read.content': 'What rfid.tag.read.execute reads from the tag: EPC, TID, user memory…',
  'rfid.tag.read.execute': 'Reads the tag as rfid.tag.read.content says.',
  'rfid.tag.read.result_line1': 'The first line of the last tag read.',
  'rfid.tag.read.result_line1_alternate': 'The first line of the last tag read, in its alternate form.',
  'rfid.tag.read.result_line2': 'The second line of the last tag read.',
  'rfid.tag.read.result_line2_alternate': 'The second line of the last tag read, in its alternate form.',
  'rfid.tag.test.content': 'Which test rfid.tag.test.execute runs on the tag: quick, or a fuller one.',
  'rfid.tag.test.execute': 'Runs the tag test rfid.tag.test.content names.',
  'rfid.tag.test.result_line1': 'The first line of the last tag test result.',
  'rfid.tag.test.result_line2': 'The second line of the last tag test result.',
  'rfid.void_print_length': 'How much of a failed RFID label is printed with VOID.',
  'rfid.void_print_speed': 'The speed VOID labels are printed at.',
  'ribbon.cartridge.inserted': 'Whether a ribbon cartridge is in.',
  'ribbon.part_number': 'The part number of the ribbon loaded, for your records.',
  'ribbon.ribbon_low.warning': 'Warn when the ribbon is running low.',
  'ribbon.serial_number': 'The serial number of the ribbon loaded, for your records.',
  'rtc.date': 'The printer clock’s date, as month-day-year (e.g. 10-04-2026). Used by ^FC date fields.',
  'rtc.exists': 'Whether the printer has a real-time clock.',
  'rtc.time': 'The printer clock’s time, as hours:minutes:seconds.',
  'rtc.timezone': 'The time zone, as a POSIX time-zone string (e.g. EST5EDT,M3.2.0,M11.1.0).',
  'rtc.unix_timestamp': 'The printer clock as seconds since 1 January 1970 (UTC).',
  'sensor.back_bar.cur': 'What the black-mark (back bar) sensor reads now.',
  'sensor.back_bar.ppr_out_thold': 'The black-mark sensor’s paper-out threshold.',
  'sensor.back_bar.thold': 'The black-mark sensor’s threshold between mark and media.',
  'sensor.gap.cur': 'What the gap sensor reads now.',
  'sensor.gap.ppr_out_thold': 'The gap sensor’s paper-out threshold.',
  'sensor.gap.thold': 'The gap sensor’s threshold between gap and label.',
  'sensor.head.temp': 'The printhead’s temperature now.',
  'sensor.head.temp_avg': 'The printhead’s average temperature, in °C.',
  'sensor.head.temp_celsius': 'The printhead’s temperature now, in °C.',
  'sensor.paper_supply': 'Whether there is paper.',
  'sensor.peel.cur': 'What the peel sensor reads now.',
  'sensor.peeler': 'Whether a peeled label is waiting to be taken.',
  'sensor.peeler_present': 'Whether a peeler is fitted.',
  'sensor.recall_factory_cal': 'Puts the media sensors back to their factory calibration.',
  'usb.connected': 'Whether a computer is connected by USB.',
  'usb.device.device_id_string': 'The IEEE 1284 device ID string the printer gives a computer over USB.',
  'usb.device.device_unique_id':
    'Whether the printer gives a computer its own serial number over USB, so two printers are told apart.',
  'usb.device.device_version': 'The USB device version.',
  'usb.device.manufacturer_string': 'The manufacturer name given over USB.',
  'usb.device.product_id': 'The USB product ID.',
  'usb.device.product_string': 'The product name given over USB.',
  'usb.device.serial_string': 'The serial number given over USB.',
  'usb.device.vendor_id': 'The USB vendor ID.',
  'usb.halt': 'Whether USB communication stops while the printer is in an error state.',
  'usb.host.config_info_to_usb': 'Saves the configuration (as ^HH reports) to a USB drive.',
  'usb.host.hid_count': 'How many USB keyboards, scanners and other HID devices are plugged in.',
  'usb.host.lock_out': 'Disables the USB host port (where drives and scanners plug in).',
  'usb.host.mass_storage_count': 'How many USB drives are plugged in.',
  'usb.host.read_list': 'Lists the files on the USB drive that can be printed or copied.',
  'usb.host.read_list_print_delay': 'Milliseconds between files when printing everything from a USB drive.',
  'usb.host.write_list': 'Lists the files on E: that can be copied to a USB drive.',
  'usb.mirror.enable': 'Turns USB Mirror on: updating the printer from a USB drive’s mirror directory.',
  'weblink.cloud_connect.configuration_confirmation': 'Confirms a CloudConnect configuration.',
  'weblink.cloud_connect.configuration_key': 'The CloudConnect configuration key.',
  'weblink.cloud_connect.connect': 'Connects to CloudConnect now.',
  'weblink.cloud_connect.connection_key': 'The CloudConnect connection key.',
  'weblink.cloud_connect.enable': 'Shows the CloudConnect menu.',
  'weblink.cloud_connect.status': 'The state of the CloudConnect connection.',
  'weblink.enable': 'Whether any WebLink (outgoing cloud) connection is active.',
  'weblink.logging.clear': 'Clears the WebLink log. Any value does it.',
  'weblink.logging.entries': 'The WebLink log.',
  'weblink.logging.max_entries': 'How many WebLink log entries are kept; 0 turns the log off.',
  'weblink.printer_reset_required': 'Whether WebLink settings have changed and need a restart.',
  'weblink.restore_defaults': 'Puts the WebLink settings back to their defaults.',
  'weblink.zebra_connector.authentication.add': 'Adds credentials for a server the Zebra Connector talks to.',
  'weblink.zebra_connector.authentication.entries': 'The servers with stored Zebra Connector credentials.',
  'weblink.zebra_connector.authentication.remove': 'Removes a server’s Zebra Connector credentials.',
  'weblink.zebra_connector.enable': 'Turns the Visibility Agent (Zebra Connector) on or off.',
  'weblink.zebra_connector.proxy': 'The proxy for the Zebra Connector, as a URL.',
  'weblink.zebra_connector.version': 'The Zebra Connector’s version.',
});

/* WebLink's two outgoing connections, conn1 and conn2, have the same settings. */
const WEBLINK_CONN = {
  'authentication.add': 'Adds a server, user name and password for WebLink connection {n} to use.',
  'authentication.entries': 'The servers with stored credentials for WebLink connection {n} (names only).',
  'authentication.remove': 'Removes a server’s credentials from WebLink connection {n}.',
  location: 'The HTTPS URL WebLink connection {n} connects out to.',
  maximum_simultaneous_connections: 'How many connections WebLink connection {n} may open at once.',
  num_connections: 'How many connections WebLink connection {n} has open.',
  proxy: 'The proxy for WebLink connection {n}, as a URL.',
  retry_interval: 'Seconds between attempts to connect WebLink connection {n}.',
  retry_interval_random_max: 'The most random extra seconds to wait between attempts, for WebLink connection {n}.',
  'test.location': 'A URL to test internet access with, for WebLink connection {n}.',
  'test.retry_interval': 'Seconds between connection tests for WebLink connection {n}.',
  'test.test_on': 'When to test WebLink connection {n}: never, on failure, at intervals, or both.',
};
for (const n of [1, 2]) {
  for (const [suffix, text] of Object.entries(WEBLINK_CONN)) {
    SGD[`weblink.ip.conn${n}.${suffix}`] = text.replace('{n}', n);
  }
}

Object.assign(SGD, {
  'wlan.11d.current_country': 'The country the wireless radio has worked out it is in (802.11d).',
  'wlan.11d.discovered_channels': 'The channels the radio has found allowed where it is (802.11d).',
  'wlan.11d.enable': 'Let the radio set its regulatory rules from the access points around it (802.11d).',
  'wlan.11n.20mhz_only': 'Use only 20 MHz channels on an 802.11n radio.',
  'wlan.11n.amsdu': 'Use A-MSDU frame aggregation on 802.11n.',
  'wlan.11n.greenfield': 'Use 802.11n greenfield mode (no older-standard compatibility).',
  'wlan.11n.rifs': 'Use the reduced interframe space on 802.11n.',
  'wlan.11n.short_gi_20mhz': 'Use the short guard interval on 20 MHz channels.',
  'wlan.11n.short_gi_40mhz': 'Use the short guard interval on 40 MHz channels.',
  'wlan.active_channels': 'The channels in use, from the allowed band and the channel list.',
  'wlan.adhocautomode': 'Join an ad hoc network automatically.',
  'wlan.adhocchannel': 'The channel to use for an ad hoc network.',
  'wlan.allowed_band': 'Which wireless band may be used: 2.4 GHz, 5 GHz or both.',
  'wlan.associated': 'Whether the printer is connected to an access point.',
  'wlan.authenticated': 'Whether the wireless connection is authenticated.',
  'wlan.authentication_error': 'The last wireless authentication error, if any.',
  'wlan.available': 'Whether a wireless radio is fitted.',
  'wlan.band_preference': 'Which band to prefer when both are available.',
  'wlan.bssid': 'The MAC address of the access point the printer is connected to.',
  'wlan.channel': 'The wireless channel in use.',
  'wlan.country_code': 'The country the wireless radio is set up for.',
  'wlan.current_essid': 'The name (ESSID) of the wireless network the printer is on.',
  'wlan.current_tx_rate': 'The current wireless transmit rate.',
  'wlan.enable': 'Turns wireless networking on or off.',
  'wlan.encryption_optional': 'Allow connecting to networks without encryption.',
  'wlan.essid': 'The name (ESSID) of the wireless network to join.',
  'wlan.firmware_version': 'The wireless radio’s firmware version.',
  'wlan.international_mode': 'Use the channels the access point offers (international mode).',
  'wlan.keep_alive.enable': 'Send a small packet to the access point now and then, to stay connected.',
  'wlan.keep_alive.timeout': 'Seconds between those keep-alive packets.',
  'wlan.operating_mode': 'Infrastructure (through an access point) or ad hoc.',
  'wlan.password': 'The password for wireless security types that need one. Write-only.',
  'wlan.permitted_channels': 'The channels the radio is permitted to use.',
  'wlan.pmf': 'Protected Management Frames (802.11w): disabled, optional or required.',
  'wlan.poor_signal_threshold': 'The signal strength, in percent, below which the signal counts as poor.',
  'wlan.power_save': 'Wireless power-saving mode.',
  'wlan.preamble': 'The radio preamble: long or short.',
  'wlan.private_key_password': 'The private key password for certificate-based wireless security. Write-only.',
  'wlan.region_code': 'The region the wireless radio is licensed for.',
  'wlan.regulatory_data_version': 'The version of the radio’s regulatory data.',
  'wlan.roam.interchannel_delay': 'Milliseconds to wait between channels while looking for a better access point.',
  'wlan.roam.interval': 'Seconds between checks for a better access point.',
  'wlan.roam.max_chan_scan_time': 'Milliseconds to listen on each channel while roaming.',
  'wlan.roam.max_fail': 'How many failed transmissions in a row start a search for another access point.',
  'wlan.roam.monitor': 'Whether roaming events are reported.',
  'wlan.roam.rssi': 'The signal level (as negative dBm) below which the radio looks for a better access point.',
  'wlan.roam.signal': 'The signal strength, in percent, below which the radio looks for a better access point.',
  'wlan.secure_ssid': 'Hide the network name on the printer’s display and reports.',
  'wlan.security':
    'The wireless security type -- none, WEP, WPA/WPA2 personal (PSK) or one of the enterprise (EAP) types -- in one setting.',
  'wlan.signal_strength': 'The strength of the connection to the access point, in percent.',
  'wlan.station_name': 'The printer’s station name on the wireless network.',
  'wlan.user_channel_list': 'The channels the radio may use.',
  'wlan.username': 'The user name for wireless security types that need one.',
  'wlan.waveagent.enable': 'Turns on the WaveAgent wireless test agent.',
  'wlan.waveagent.udp_port': 'The UDP port the WaveAgent test agent uses.',
  'wlan.wpa.groupkey_ciphersuite': 'The cipher used for broadcast traffic.',
  'wlan.wpa.pairwise_ciphersuite': 'The cipher used for the printer’s own traffic.',
  'wlan.wpa.psk': 'The WPA pre-shared key, as 64 hex digits. Write-only.',
  'wlan.wpa.timecheck': 'Whether certificate dates are checked when connecting with WPA and TLS.',
  'wlan.wpa.wpa_version': 'Which WPA version is in use.',
  'zbi.control.add_breakpoint': 'Debugging ZBI: sets a breakpoint at a program line.',
  'zbi.control.break': 'Debugging ZBI: stops the running program.',
  'zbi.control.clear_breakpoints': 'Debugging ZBI: removes every breakpoint.',
  'zbi.control.delete_breakpoint': 'Debugging ZBI: removes one breakpoint.',
  'zbi.control.line_number': 'Debugging ZBI: the line a stopped program is at.',
  'zbi.control.restart': 'Debugging ZBI: carries on running a stopped program.',
  'zbi.control.run': 'Runs the ZBI program loaded in the interpreter.',
  'zbi.control.step': 'Debugging ZBI: runs one line of a stopped program.',
  'zbi.control.terminate': 'Ends the ZBI program and shuts the interpreter down.',
  'zbi.control.variable_name': 'Debugging ZBI: which variable zbi.control.variable_value reads or sets.',
  'zbi.control.variable_value': 'Debugging ZBI: the value of that variable.',
  'zbi.enable': 'Turns ZBI (Zebra BASIC) on or off.',
  'zbi.key': 'Whether ZBI is licensed on this printer.',
  'zbi.key_version': 'The version of the ZBI licence key.',
  'zbi.last_error': 'The last error the ZBI interpreter met.',
  'zbi.program_list': 'Lists the ZBI programs on the printer, for showing in a WML menu.',
  'zbi.reseller_key': 'A key that lets ZBI programs encrypted with it run.',
  'zbi.revision': 'The ZBI version.',
  'zbi.running_program_name': 'The ZBI program running now.',
  'zbi.start_info.execute': 'Runs the ZBI program zbi.start_info.file_name names.',
  'zbi.start_info.file_name': 'The ZBI program to run with zbi.start_info.execute.',
  'zbi.start_info.memory_alloc': 'Memory in use by the ZBI program.',
  'zbi.state': 'What the ZBI interpreter is doing: running, stopped, off…',
  'zpl.calibrate': 'Measures the label length and sets zpl.label_length (as ~JL).',
  'zpl.command_prefix': 'The ZPL command prefix character (normally ^), as a hex code.',
  'zpl.delimiter': 'The ZPL parameter delimiter (normally a comma), as a hex code.',
  'zpl.format_prefix': 'The ZPL format prefix character (normally ^), as a hex code (as ^CC).',
  'zpl.label_length':
    'The label length in dots (as ^LL) -- needed on continuous media. A new label in the editor takes this length.',
  'zpl.label_top': 'Moves the whole label up or down, in dot rows (as ^LT).',
  'zpl.left_position': 'Shifts the whole label left or right, in dots (as ^LS).',
  'zpl.no_errors_boot_done': 'Whether the printer started up without errors.',
  'zpl.print_orientation': 'Prints labels normally or upside down (as ^PO).',
  'zpl.relative_darkness': 'Adjusts darkness relative to the configured setting (as ^MD).',
  'zpl.save': 'Saves the current settings so they survive a restart (as ^JUS).',
  'zpl.system_error': 'The error flags, as ~HQES reports them.',
  'zpl.system_status': 'The errors and warnings, as ~HQES reports them.',
  'zpl.zpl_mode': 'ZPL or ZPL II (as ^SZ).',
});
