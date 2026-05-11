use anchor_lang::error::Error;

use crate::errors::StendarError;

pub fn assert_stendar_error(err: Error, expected: StendarError) {
    match err {
        Error::AnchorError(anchor_err) => {
            assert_eq!(anchor_err.error_name, format!("{expected:?}"));
        }
        _ => panic!("expected AnchorError variant"),
    }
}
