#[derive(Debug, PartialEq)]
pub enum CloseAction {
    Hide,
    Quit,
    Confirm,
}

pub fn action(explicit: bool, tray: bool, confirm: bool, tabs: usize) -> CloseAction {
    if !explicit && tray {
        CloseAction::Hide
    } else if confirm && tabs > 1 {
        CloseAction::Confirm
    } else {
        CloseAction::Quit
    }
}

pub fn finish_confirmation(confirmed: bool) -> Option<CloseAction> {
    confirmed.then_some(CloseAction::Quit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_close_hides_but_tray_quit_does_not() {
        assert_eq!(action(false, true, true, 3), CloseAction::Hide);
        assert_eq!(action(true, true, true, 3), CloseAction::Confirm);
        assert_eq!(action(true, true, false, 3), CloseAction::Quit);
    }

    #[test]
    fn native_close_confirms_only_for_multiple_tabs() {
        for tabs in 0..=3 {
            assert_eq!(
                action(false, false, true, tabs),
                if tabs > 1 {
                    CloseAction::Confirm
                } else {
                    CloseAction::Quit
                }
            );
            assert_eq!(action(false, false, false, tabs), CloseAction::Quit);
        }
    }

    #[test]
    fn cancelled_confirmation_never_exits() {
        assert_eq!(finish_confirmation(false), None);
        assert_eq!(finish_confirmation(true), Some(CloseAction::Quit));
    }
}
